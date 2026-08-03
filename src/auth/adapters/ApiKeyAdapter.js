const AuthAdapter = require('../AuthAdapter');

/**
 * ApiKeyAdapter
 *
 * Simplest auth type: a static API key/token (OpenAI, Grok, Gemini, DeepSeek,
 * etc.). Overrides expireAt when the provider config includes a token.
 *
 * The adapter only deals with plain credential objects; persistence happens
 * through the registry (save/load) so it never touches a storage backend.
 */
class ApiKeyAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'api-key', ...opts });
  }

  async connect(config = {}) {
    const key = config.apiKey || config.key || config.token;
    if (!key) {
      const err = new Error('api-key: an API key is required to connect');
      err.code = 'AUTH_MISSING_CREDENTIAL';
      throw err;
    }
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: { apiKey: key },
      connectedAt: Date.now(),
      expiresAt: null,
    };
    // Allow adapters to store extra state without core changes.
    for (const k of ['expiresAt', 'scope']) {
      if (config[k] !== undefined) account[k] = config[k];
    }
    this._log('connected with api-key', { providerId: account.providerId });
    return account;
  }

  async refresh(account) {
    // Static keys do not rotate; a re-connect simply re-validates.
    account.connectedAt = Date.now();
    return account;
  }

  async disconnect(account) {
    return account && account.accountId ? account.accountId : null;
  }

  async status(account) {
    if (!account || !account.credential || !account.credential.apiKey) {
      return { state: 'disconnected' };
    }
    if (account.expiresAt && Date.now() >= account.expiresAt) {
      return { state: 'expired', connectedAt: account.connectedAt, expiresAt: account.expiresAt };
    }
    return { state: 'connected', connectedAt: account.connectedAt, expiresAt: account.expiresAt || null };
  }
}

module.exports = ApiKeyAdapter;
