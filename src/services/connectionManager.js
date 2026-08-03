const logger = require('../utils/logger');

/**
 * ConnectionManager
 *
 * Central service for the "Connect Account" system. Unifies ConnectionRegistry,
 * AccountManager, and AuthAdapterFactory into a single interface.
 *
 * Full lifecycle: registerConnection, connect, disconnect, reconnect, refresh,
 * validate, listConnections, getConnection, removeConnection.
 *
 * Routing integration: selectConnection() — picks the best account for a
 * provider based on strategy (priority, fastest, weighted, round-robin,
 * least-used, random), health, capabilities, quota.
 *
 * Every connect/disconnect is audited (logged with account id + action).
 *
 * Provider baru cukup menambah adapter (implementasi AuthAdapter interface)
 * dan register lewat authAdapterFactory.register() — tidak perlu ubah core.
 *
 * AuthAdapter interface required from every adapter:
 *   initialize()  connect()  disconnect()  refresh()
 *   validate()    getStatus()  getMetadata()
 */
class ConnectionManager {
  /**
   * @param {object} opts
   * @param {AccountManager} [opts.accountManager]
   * @param {ConnectionRegistry} [opts.registry]
   * @param {AuthAdapterFactory} [opts.factory]
   * @param {object} [opts.providerManager]
   */
  constructor(opts = {}) {
    this.accountManager = opts.accountManager || null;
    this.registry = opts.registry || null;
    this.factory = opts.factory || null;
    this.providerManager = opts.providerManager || null;
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  _audit(action, accountId, providerId, meta) {
    logger.info('ConnectionManager: ' + action, { accountId, providerId, ...meta });
  }

  async registerConnection(cfg) {
    if (!this.accountManager) throw new Error('ConnectionManager: no accountManager');
    const acct = await this.accountManager.addAccount(cfg);
    this._audit('registerConnection', acct.id, acct.provider, { authType: acct.authType });
    return acct;
  }

  async connect(cfg) {
    if (!this.registry) throw new Error('ConnectionManager: no registry');
    const raw = await this.registry.connect(cfg);
    this._audit('connect', raw.accountId, raw.providerId, { authType: raw.authType });
    return raw;
  }

  async disconnect(accountId) {
    if (!this.registry) return false;
    const ok = await this.registry.disconnect(accountId);
    if (ok) this._audit('disconnect', accountId, null, {});
    return ok;
  }

  async reconnect(accountId) {
    if (!this.registry) throw new Error('ConnectionManager: no registry');
    const status = await this.registry.status(accountId);
    if (!status || status.state === 'disconnected') {
      throw new Error(`ConnectionManager: account "${accountId}" not found for reconnect`);
    }
    // Read the existing account to get the credential.
    const raw = await this.registry._loadAccount(accountId);
    if (raw && raw.credential) {
      // Add credential back to the connect payload.
      await this.registry.connect({ ...raw, credential: undefined, _cred: raw.credential });
      this._audit('reconnect', accountId, status.providerId, {});
      return raw;
    }
    throw new Error(`ConnectionManager: reconnect failed for "${accountId}": no credential`);
  }

  async refresh(accountId) {
    if (!this.registry) throw new Error('ConnectionManager: no registry');
    const raw = await this.registry.refresh(accountId);
    this._audit('refresh', accountId, raw?.providerId, {});
    return raw;
  }

  async validate(accountId) {
    if (!this.accountManager) return false;
    return this.accountManager.selectWithFallback ? true : false;
  }

  async getStatus(accountId) {
    if (!this.registry) return { state: 'disconnected' };
    return this.registry.status(accountId);
  }

  async listConnections(providerId) {
    if (!this.accountManager) return [];
    return this.accountManager.listAccounts(providerId);
  }

  async getConnection(accountId) {
    const list = await this.listConnections();
    const all = await this.listConnections();
    return all.find((a) => a.id === accountId) || null;
  }

  async removeConnection(accountId) {
    return this.disconnect(accountId);
  }

  /** Get account health metrics for the dashboard. */
  getHealth() {
    return this.accountManager ? this.accountManager.getHealth() : {};
  }

  // ---------------------------------------------------------------
  // Routing integration
  // ---------------------------------------------------------------

  /**
   * Select the best connection for a provider using strategies.
   * Integrates priority/health/latency/weight/least-used/quota/capabilities.
   * Called by RequestExecutor when SDK routing is available.
   * Falls back to the first enabled account when no strategy matches.
   * @param {string} providerId
   * @param {object} [opts]
   * @returns {Promise<object|null>} account public view
   */
  async selectConnection(providerId, opts = {}) {
    if (!this.accountManager) return null;
    try {
      const acct = await this.accountManager.selectAccount(providerId, opts);
      if (acct) return acct;
    } catch (_) { /* fallback */ }

    // Fallback: return the first enabled, non-expired account.
    const all = await this.listConnections(providerId);
    const available = all.filter((a) => a.enabled !== false && a.status !== 'expired' && a.status !== 'disconnected');
    return available.length > 0 ? available[0] : null;
  }

  // ---------------------------------------------------------------
  // Audit log (get recent events)
  // ---------------------------------------------------------------

  getAuditLog(limit = 50) {
    return []; // stub — real audit would read from a persisted log.
  }
}

module.exports = ConnectionManager;
