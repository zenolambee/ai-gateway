const AuthAdapter = require('../AuthAdapter');

/**
 * CustomAdapter
 *
 * Generic hook adapter for any provider not covered by the built-in types
 * (Grok, Qwen, Kimi, Cursor, Windsurf, Copilot, or any future provider).
 *
 * It exposes the full lifecycle by delegating to optional user-supplied
 * functions passed via config (connectFn/refreshFn/disconnectFn/statusFn/
 * validateFn). When a hook is missing, it falls back to the base behavior.
 *
 * Because it implements the SAME interface, adding a new provider = writing a
 * new adapter (or supplying hooks) — the core gateway never changes.
 */
class CustomAdapter extends AuthAdapter {
  constructor(opts = {}) {
    super({ type: 'custom', ...opts });
    this.hooks = opts.hooks || {};
  }

  async connect(config = {}) {
    if (typeof this.hooks.connect === 'function') {
      return this.hooks.connect(config, this);
    }
    const account = {
      providerId: config.providerId,
      accountId: config.accountId || config.providerId,
      authType: this.type,
      name: config.name || config.providerId,
      credential: config.credential || config.token || { any: config.apiKey || null },
      connectedAt: Date.now(),
      expiresAt: typeof config.expiresAt === 'number' ? config.expiresAt : null,
      meta: config.meta || null,
    };
    if (!account.credential) {
      const err = new Error('custom: a credential is required');
      err.code = 'AUTH_MISSING_CREDENTIAL';
      throw err;
    }
    return account;
  }

  async refresh(account) {
    if (typeof this.hooks.refresh === 'function') {
      return this.hooks.refresh(account, this);
    }
    if (account) { account.connectedAt = Date.now(); account.lastRefreshedAt = Date.now(); }
    return account;
  }

  async disconnect(account) {
    if (typeof this.hooks.disconnect === 'function') {
      return this.hooks.disconnect(account, this);
    }
    return account && account.accountId ? account.accountId : null;
  }

  async status(account) {
    if (typeof this.hooks.status === 'function') {
      return this.hooks.status(account, this);
    }
    if (!account || !account.credential) return { state: 'disconnected' };
    if (account.expiresAt && Date.now() >= account.expiresAt) return { state: 'expired' };
    return { state: 'connected', connectedAt: account.connectedAt, expiresAt: account.expiresAt || null };
  }

  validate(account) {
    if (typeof this.hooks.validate === 'function') {
      return !!this.hooks.validate(account, this);
    }
    return !!(account && account.credential)
      && !(account.expiresAt && Date.now() >= account.expiresAt);
  }
}

module.exports = CustomAdapter;
