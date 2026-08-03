const AuthAdapter = require('../AuthAdapter');

/**
 * DeviceCodeAdapter
 *
 * OAuth 2.0 device-authorization-flow adapter. Makes real HTTP requests to
 * the device authorization endpoint, then polls the token endpoint at the
 * specified interval until the user authorizes on another device, or the
 * flow expires.
 *
 * States:
 *   - reconnecting : waiting for user to authorize (device code issued)
 *   - connected    : user authorized, tokens received
 *   - expired      : user didn't authorize before expiry
 *   - refreshing   : polling or retrying
 *   - disconnected : revoked / removed
 *
 * The adapter receives httpClient from the registry; it never touches storage.
 */
class DeviceCodeAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'device-code', ...opts });
  }

  /**
   * Resolve OAuth endpoint URLs from config or provider catalog.
   */
  _endpoints(config) {
    return {
      deviceAuthUrl: config.deviceAuthUrl || (config.catalog && config.catalog.endpoints && config.catalog.endpoints.deviceAuth),
      tokenUrl: config.tokenUrl || (config.catalog && config.catalog.endpoints && config.catalog.endpoints.oauthToken),
    };
  }

  async connect(config = {}) {
    const endpoints = this._endpoints(config);
    const clientId = config.clientId;
    const deviceAuthUrl = config.deviceAuthUrl || endpoints.deviceAuthUrl;

    // When the caller provides a pre-issued device code (UI-initiated flow),
    // use it directly without hitting the device auth endpoint.
    if (config.deviceCode) {
      const account = {
        providerId: config.providerId,
        accountId: config.accountId || config.providerId,
        authType: this.type,
        name: config.name || config.providerId,
        credential: {
          deviceCode: config.deviceCode,
          userCode: config.userCode || null,
          verificationUri: config.verificationUri || null,
          clientId,
          endpoints,
          status: 'pending',
        },
        connectedAt: null,
        expiresAt: config.expiresAt || (Date.now() + (config.expiresIn || 600) * 1000),
      };
      this._log('device-code: initialized with device code', { providerId: account.providerId });
      return account;
    }

    // Real device authorization request.
    if (deviceAuthUrl && clientId) {
      const body = { client_id: clientId, scope: config.scope || undefined };
      const res = await this._httpRequest(deviceAuthUrl, body);
      const account = {
        providerId: config.providerId,
        accountId: config.accountId || config.providerId,
        authType: this.type,
        name: config.name || config.providerId,
        credential: {
          deviceCode: res.device_code,
          userCode: res.user_code || String(Math.floor(100000 + Math.random() * 900000)),
          verificationUri: res.verification_uri || res.verification_url || config.verificationUri || null,
          verificationUriComplete: res.verification_uri_complete || null,
          clientId,
          clientSecret: config.clientSecret || null,
          endpoints,
          status: 'pending',
          interval: res.interval || 5,
        },
        connectedAt: null,
        expiresAt: Date.now() + (res.expires_in || 600) * 1000,
      };
      this._log('device-code: started device flow', {
        providerId: account.providerId,
        userCode: account.credential.userCode,
        verificationUri: account.credential.verificationUri,
        interval: account.credential.interval,
      });
      return account;
    }

    // Fallback: standalone/pending mock if no endpoint available.
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: {
        deviceCode: `dev-${Math.random().toString(36).slice(2, 10)}`,
        userCode: String(Math.floor(100000 + Math.random() * 900000)),
        verificationUri: config.verificationUri || config.providerUrl || null,
        status: 'pending',
        interval: 5,
      },
      connectedAt: null,
      expiresAt: Date.now() + 600000,
    };
    this._log('device-code: fallback (no endpoint)', { providerId: account.providerId });
    return account;
  }

  async refresh(account) {
    if (!account || !account.credential) return account;
    const { deviceCode, clientId, clientSecret, endpoints, status } = account.credential;
    const tokenUrl = endpoints && (endpoints.tokenUrl || endpoints.oauthToken);

    if (deviceCode && tokenUrl && status !== 'authorized') {
      try {
        const body = {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: clientId,
        };
        if (clientSecret) body.client_secret = clientSecret;
        const res = await this._httpRequest(tokenUrl, body);

        // Success: user authorized.
        account.credential.accessToken = res.access_token;
        account.credential.refreshToken = res.refresh_token || null;
        account.credential.status = 'authorized';
        account.connectedAt = Date.now();
        if (res.expires_in) account.expiresAt = Date.now() + res.expires_in * 1000;
        this._log('device-code: authorized by user', { providerId: account.providerId });
        return account;
      } catch (err) {
        // OAuth device-returned errors are informational, not fatal.
        if (err.code === 'AUTH_HTTP_ERROR') {
          const data = err.payload || {};
          const errorCode = data.error;
          if (errorCode === 'authorization_pending') {
            // User hasn't authorized yet — continue polling.
            return account;
          }
          if (errorCode === 'slow_down') {
            // Increase polling interval.
            account.credential.interval = (account.credential.interval || 5) + 5;
            this._log('device-code: slow_down, interval increased', { interval: account.credential.interval });
            return account;
          }
          if (errorCode === 'expired_token') {
            account.credential.status = 'expired';
            this._log('device-code: expired_token', { providerId: account.providerId });
            return account;
          }
          if (errorCode === 'access_denied') {
            account.credential.status = 'denied';
            this._log('device-code: access_denied', { providerId: account.providerId });
            return account;
          }
        }
        // Re-throw non-device errors so the scheduler can retry/backoff.
        throw err;
      }
    }

    // Simulated offline refresh: mark as connected.
    if (account.credential.status === 'pending') {
      account.credential.status = 'authorized';
      account.connectedAt = Date.now();
    }
    return account;
  }

  async disconnect(account) {
    return account && account.accountId ? account.accountId : null;
  }

  async status(account) {
    if (!account || !account.credential) return { state: 'disconnected' };
    if (account.credential.status === 'denied') return { state: 'disconnected' };
    if (!account.connectedAt) {
      if (account.expiresAt && Date.now() >= account.expiresAt) {
        return { state: 'expired' };
      }
      // Device code issued but waiting for user.
      return {
        state: account.credential.verificationUri ? 'need-device' : 'waiting',
        userCode: account.credential.userCode,
        verificationUri: account.credential.verificationUri || null,
        verificationUriComplete: account.credential.verificationUriComplete || null,
        interval: account.credential.interval || 5,
        expiresAt: account.expiresAt || null,
      };
    }
    return { state: 'connected', connectedAt: account.connectedAt, expiresAt: account.expiresAt || null };
  }

  validate(account) {
    return !!(account && account.connectedAt && account.credential && account.credential.accessToken);
  }

  /**
   * Send a form-urlencoded request to an OAuth endpoint.
   * @private
   */
  async _httpRequest(url, body) {
    const client = this._httpClient;
    if (!client || typeof client.request !== 'function') {
      const axios = require('axios');
      const res = await axios({
        method: 'POST', url,
        data: new URLSearchParams(body || {}).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        validateStatus: () => true,
        timeout: 15000,
      });
      if (res.status >= 400) {
        const err = new Error('Device auth endpoint responded ' + res.status + ': ' + JSON.stringify(res.data));
        err.code = 'AUTH_HTTP_ERROR';
        err.statusCode = res.status;
        err.payload = res.data;
        throw err;
      }
      return res.data;
    }
    const res = await client.request({
      url, method: 'POST', form: true, body,
      headers: {}, timeout: 15000, raw: true,
    });
    if (res.status >= 400) {
      const err = new Error('Device auth endpoint responded ' + res.status + ': ' + JSON.stringify(res.data));
      err.code = 'AUTH_HTTP_ERROR';
      err.statusCode = res.status;
      err.payload = res.data;
      throw err;
    }
    return res.data;
  }
}

module.exports = DeviceCodeAdapter;
