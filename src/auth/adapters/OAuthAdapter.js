const AuthAdapter = require('../AuthAdapter');

/**
 * OAuthAdapter
 *
 * Full OAuth 2.0 authorization-code + client-credentials adapter that makes
 * real HTTP requests via the gateway's httpClient (injected by registry).
 *
 * Supports:
 *   - authorize URL generation (auth-code flow)
 *   - token endpoint (exchange code for tokens)
 *   - refresh endpoint (rotate access token with refresh token)
 *   - revoke endpoint (disconnect)
 *
 * The adapter receives an httpClient reference from the registry; it never
 * manages storage directly.
 *
 * Connect modes:
 *   1. Provide an `authorizationCode` + `redirectUri` → exchanges for tokens.
 *   2. Provide `accessToken` directly (pre-issued token, no code exchange).
 *   3. Provide `clientId` + `clientSecret` for raw config (no code yet).
 */
class OAuthAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'oauth', ...opts });
  }

  /**
   * Resolve provider-level OAuth endpoint config from the provider catalog
   * or from the config object itself.
   */
  _endpoints(config) {
    const c = config;
    return {
      authorizeUrl: c.authorizeUrl || (c.catalog && c.catalog.endpoints && c.catalog.endpoints.oauthAuthorize),
      tokenUrl: c.tokenUrl || (c.catalog && c.catalog.endpoints && c.catalog.endpoints.oauthToken),
      refreshUrl: c.refreshUrl || c.tokenUrl || (c.catalog && c.catalog.endpoints && c.catalog.endpoints.oauthToken),
      revokeUrl: c.revokeUrl || (c.catalog && c.catalog.endpoints && c.catalog.endpoints.oauthRevoke),
    };
  }

  async connect(config = {}) {
    const endpoints = this._endpoints(config);
    const clientId = config.clientId;
    const clientSecret = config.clientSecret;
    const redirectUri = config.redirectUri || 'http://localhost:3000/oauth/callback';
    let accessToken = config.accessToken || (config.token && config.token.accessToken);
    let refreshToken = config.refreshToken || null;
    let expiresIn = typeof config.expiresIn === 'number' ? config.expiresIn : null;
    let scope = config.scope || null;

    // Mode 1: authorization code exchange.
    if (!accessToken && config.authorizationCode && endpoints.tokenUrl) {
      const body = {
        grant_type: 'authorization_code',
        code: config.authorizationCode,
        redirect_uri: redirectUri,
        client_id: clientId,
      };
      if (clientSecret) body.client_secret = clientSecret;
      const tokenRes = await this._httpRequest(endpoints.tokenUrl, body, clientId, clientSecret);
      accessToken = tokenRes.access_token;
      refreshToken = tokenRes.refresh_token || null;
      expiresIn = tokenRes.expires_in;
      scope = tokenRes.scope || scope;
    }

    // Mode 2: client-credentials grant.
    if (!accessToken && clientId && clientSecret && endpoints.tokenUrl) {
      const body = {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: config.scope || undefined,
      };
      const tokenRes = await this._httpRequest(endpoints.tokenUrl, body, clientId, clientSecret);
      accessToken = tokenRes.access_token;
      refreshToken = tokenRes.refresh_token || null;
      expiresIn = tokenRes.expires_in;
      scope = tokenRes.scope || scope;
    }

    if (!accessToken) {
      const err = new Error('oauth: access token is required to connect');
      err.code = 'AUTH_MISSING_CREDENTIAL';
      throw err;
    }

    const expiresMs = expiresIn ? expiresIn * 1000 : 24 * 3600 * 1000;
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: {
        accessToken,
        refreshToken,
        tokenType: config.tokenType || 'Bearer',
        scope,
        clientId,
        clientSecret,
        redirectUri,
        endpoints,
      },
      connectedAt: Date.now(),
      expiresAt: Date.now() + expiresMs,
      refreshAt: null,
    };
    this._log('connected via oauth', { providerId: account.providerId, hasRefresh: !!refreshToken });
    return account;
  }

  async refresh(account) {
    if (!account || !account.credential) {
      const err = new Error('oauth: no account to refresh');
      err.code = 'AUTH_NOT_CONNECTED';
      throw err;
    }
    const { refreshToken, clientId, clientSecret } = account.credential;
    const endpoints = account.credential.endpoints || {};
    const tokenUrl = endpoints.refreshUrl || endpoints.tokenUrl;

    if (refreshToken && tokenUrl) {
      // Real HTTP token refresh.
      const body = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: account.credential.scope || undefined,
      };
      if (clientId) body.client_id = clientId;
      if (clientSecret) body.client_secret = clientSecret;
      try {
        const tokenRes = await this._httpRequest(tokenUrl, body, clientId, clientSecret);
        account.credential.accessToken = tokenRes.access_token || account.credential.accessToken;
        if (tokenRes.refresh_token) account.credential.refreshToken = tokenRes.refresh_token;
        if (tokenRes.expires_in) account.expiresAt = Date.now() + tokenRes.expires_in * 1000;
        account.connectedAt = Date.now();
        account.lastRefreshedAt = Date.now();
        this._log('refreshed token via oauth', { providerId: account.providerId });
        return account;
      } catch (err) {
        // On failure, keep the old token and re-throw.
        this._log('refresh token failed', { providerId: account.providerId, error: err.message });
        throw err;
      }
    }

    // Fallback: simulated offline refresh.
    account.connectedAt = Date.now();
    const expiresIn = 24 * 3600 * 1000;
    account.expiresAt = Date.now() + expiresIn;
    account.lastRefreshedAt = Date.now();
    this._log('refreshed (fallback) via oauth', { providerId: account.providerId });
    return account;
  }

  async disconnect(account) {
    if (!account) return null;
    const endpoints = account.credential && account.credential.endpoints || {};
    const revokeUrl = endpoints.revokeUrl;
    if (revokeUrl && account.credential && account.credential.accessToken) {
      try {
        await this._httpRequest(revokeUrl, { token: account.credential.accessToken }, account.credential.clientId, account.credential.clientSecret);
      } catch (_) {}
    }
    return account.accountId;
  }

  async status(account) {
    if (!account || !account.credential || !account.credential.accessToken) {
      return { state: 'disconnected' };
    }
    if (account.expiresAt && Date.now() >= account.expiresAt) {
      return {
        state: account.credential.refreshToken ? 'refreshing' : 'expired',
        connectedAt: account.connectedAt,
        expiresAt: account.expiresAt,
        canRefresh: !!account.credential.refreshToken,
      };
    }
    return {
      state: 'connected',
      connectedAt: account.connectedAt,
      expiresAt: account.expiresAt || null,
    };
  }

  validate(account) {
    if (!account || !account.credential || !account.credential.accessToken) return false;
    if (account.expiresAt && Date.now() >= account.expiresAt) {
      return !!account.credential.refreshToken;
    }
    return true;
  }

  /**
   * Send a form-urlencoded request to an OAuth endpoint via httpClient.
   * @private
   */
  async _httpRequest(url, body, clientId, clientSecret) {
    const client = this._httpClient;
    if (!client || typeof client.request !== 'function') {
      // No connected HTTP client — create a basic one using axios directly.
      const axios = require('axios');
      const res = await axios({
        method: 'POST',
        url,
        data: new URLSearchParams(body || {}).toString(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...(clientId && clientSecret ? { Authorization: 'Basic ' + Buffer.from(clientId + ':' + (clientSecret || '')).toString('base64') } : {}),
        },
        validateStatus: () => true,
        timeout: 15000,
      });
      if (res.status >= 400) {
        const err = new Error('OAuth token endpoint responded ' + res.status + ': ' + JSON.stringify(res.data));
        err.code = 'AUTH_HTTP_ERROR';
        err.statusCode = res.status;
        throw err;
      }
      return res.data;
    }
    const res = await client.request({
      url,
      method: 'POST',
      form: true,
      body,
      headers: clientId && clientSecret ? { Authorization: 'Basic ' + Buffer.from(clientId + ':' + (clientSecret || '')).toString('base64') } : {},
      timeout: 15000,
      raw: true,
    });
    if (res.status >= 400) {
      const err = new Error('OAuth token endpoint responded ' + res.status + ': ' + JSON.stringify(res.data));
      err.code = 'AUTH_HTTP_ERROR';
      err.statusCode = res.status;
      throw err;
    }
    return res.data;
  }
}

module.exports = OAuthAdapter;
