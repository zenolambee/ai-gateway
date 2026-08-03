const AuthAdapter = require('../AuthAdapter');

/**
 * SessionAdapter
 *
 * A generic session/cookie secret holder. Similar to browser-login but with no
 * implied expiry handling — just stores an opaque session object and exposes
 * lifecycle. Useful for providers with simple session tokens.
 */
class SessionAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'session', ...opts });
  }

  async connect(config = {}) {
    const session = config.session || config.sessionToken || config.cookies;
    if (!session) {
      const err = new Error('session: a session value is required');
      err.code = 'AUTH_MISSING_CREDENTIAL';
      throw err;
    }
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: {
        session: typeof session === 'string' ? session : JSON.stringify(session),
      },
      connectedAt: Date.now(),
      expiresAt: typeof config.expiresAt === 'number' ? config.expiresAt : null,
    };
    this._log('connected session', { providerId: account.providerId });
    return account;
  }

  async refresh(account) {
    if (account) account.connectedAt = Date.now();
    return account;
  }

  async disconnect(account) {
    return account && account.accountId ? account.accountId : null;
  }

  async status(account) {
    if (!account || !account.credential || !account.credential.session) {
      return { state: 'disconnected' };
    }
    if (account.expiresAt && Date.now() >= account.expiresAt) {
      return { state: 'expired', connectedAt: account.connectedAt, expiresAt: account.expiresAt };
    }
    return { state: 'connected', connectedAt: account.connectedAt, expiresAt: account.expiresAt || null };
  }

  validate(account) {
    return !!(account && account.credential && account.credential.session)
      && !(account.expiresAt && Date.now() >= account.expiresAt);
  }
}

module.exports = SessionAdapter;
