const AuthAdapter = require('../AuthAdapter');

/**
 * BrowserLoginAdapter
 *
 * Session/cookie based browser-login auth (used by providers like Cursor,
 * Windsurf, GitHub Copilot, ChatGPT web). A browser login typically yields
 * a set of cookies/session tokens. The adapter stores them opaquely and
 * reports expiry via a sessionExpiresAt timestamp.
 */
class BrowserLoginAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'browser-login', ...opts });
  }

  async connect(config = {}) {
    const cookies = config.cookies || config.sessionToken;
    if (!cookies) {
      const err = new Error('browser-login: session cookies/token are required');
      err.code = 'AUTH_MISSING_CREDENTIAL';
      throw err;
    }
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: {
        cookies: typeof cookies === 'string' ? cookies : JSON.stringify(cookies),
        sessionToken: config.sessionToken || null,
      },
      connectedAt: Date.now(),
      expiresAt: typeof config.sessionExpiresAt === 'number'
        ? config.sessionExpiresAt
        : Date.now() + (config.sessionTtlMs || 30 * 24 * 3600 * 1000),
    };
    this._log('connected browser session', { providerId: account.providerId });
    return account;
  }

  async refresh(account) {
    if (!account) return account;
    account.connectedAt = Date.now();
    if (account.expiresAt) {
      account.expiresAt = Date.now() + (30 * 24 * 3600 * 1000);
    }
    this._log('refreshed browser session', { providerId: account.providerId });
    return account;
  }

  async disconnect(account) {
    return account && account.accountId ? account.accountId : null;
  }

  async status(account) {
    if (!account || !account.credential) return { state: 'disconnected' };
    if (account.expiresAt && Date.now() >= account.expiresAt) {
      return { state: 'expired', connectedAt: account.connectedAt, expiresAt: account.expiresAt };
    }
    return { state: 'connected', connectedAt: account.connectedAt, expiresAt: account.expiresAt || null };
  }

  validate(account) {
    return !!(account && account.credential && account.credential.cookies)
      && !(account.expiresAt && Date.now() >= account.expiresAt);
  }
}

module.exports = BrowserLoginAdapter;
