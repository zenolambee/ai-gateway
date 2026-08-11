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
    if (ok) {
      this._audit('disconnect', accountId, null, {});
      // Keep the AccountManager's enhanced index in sync so the removed
      // connection is never selected again.
      if (this.accountManager && typeof this.accountManager.removeAccount === 'function') {
        this.accountManager.removeAccount(accountId);
      }
    }
    return ok;
  }

  async reconnect(accountId) {
    if (!this.registry) throw new Error('ConnectionManager: no registry');
    const status = await this.registry.status(accountId);
    if (!status || status.state === 'disconnected') {
      throw new Error(`ConnectionManager: account "${accountId}" not found for reconnect`);
    }
    // Read the stored account and decrypt the credential envelope in-memory
    // (never logged, never persisted in plaintext).
    const raw = await this.registry._loadAccount(accountId);
    const plain = raw && this.registry._plain(raw);
    const cred = plain && plain.credential;
    if (cred && (cred.apiKey || cred.accessToken || cred.sessionToken || cred.cookies)) {
      const enhanced = this.accountManager && this.accountManager._accounts
        ? this.accountManager._accounts.get(accountId)
        : null;
      await this.registry.connect({
        accountId,
        providerId: plain.providerId,
        authType: plain.authType,
        name: plain.name || plain.displayName,
        apiKey: cred.apiKey,
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        sessionToken: cred.sessionToken,
        cookies: cred.cookies,
      });
      // Restore enhanced fields (enabled/priority/weight/tags/…) that the
      // adapter's connect payload does not carry.
      if (enhanced && this.registry._saveAccount) {
        const reRaw = this.registry.accounts.get(accountId);
        if (reRaw) {
          await this.registry._saveAccount({ ...enhanced, credential: reRaw.credential }, reRaw.authType);
        }
      }
      this._audit('reconnect', accountId, status.providerId, {});
      return plain;
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
   * @param {string[]} [opts.connectionIds] - model-rule connection allow-list;
   *   when provided, only these connection ids are eligible.
   * @returns {Promise<object|null>} account public view
   */
  async selectConnection(providerId, opts = {}) {
    if (!this.accountManager) return null;
    const allow = Array.isArray(opts.connectionIds) && opts.connectionIds.length > 0
      ? new Set(opts.connectionIds) : null;
    try {
      // When a connection allow-list is active, pick from the restricted pool
      // directly (the AccountManager strategy runs over the filtered set).
      if (allow) {
        const all = await this.accountManager.getAvailableAccounts(providerId);
        const pool = all.filter((a) => allow.has(a.accountId || a.id));
        if (pool.length === 0) return null;
        // Delegate strategy selection over the restricted pool by calling
        // selectAccount with a temporary id filter is not supported — instead
        // run the same strategies inline for the restricted pool.
        return this._selectFromPool(pool, providerId, opts);
      }
      const acct = await this.accountManager.selectAccount(providerId, opts);
      if (acct) return acct;
    } catch (_) { /* fallback */ }

    // Fallback: return the first enabled, non-expired account.
    const all = await this.listConnections(providerId);
    let available = all.filter((a) => a.enabled !== false && a.status !== 'expired' && a.status !== 'disconnected');
    if (allow) available = available.filter((a) => allow.has(a.id || a.accountId));
    return available.length > 0 ? available[0] : null;
  }

  /**
   * Run the configured selection strategy over a pre-filtered account pool
   * (used when a model routing rule restricts the eligible connections).
   * Reuses the AccountManager's health data and cursor state — no duplicate
   * state. Round-robin rotation is anchored on account identity.
   * @param {Array<object>} pool - eligible account records (raw enhanced)
   * @param {string} providerId
   * @param {object} [opts]
   * @returns {object|null} public view of the selected account
   * @private
   */
  _selectFromPool(pool, providerId, opts = {}) {
    if (!Array.isArray(pool) || pool.length === 0) return null;
    if (pool.length === 1) {
      this.accountManager.recordUsage(pool[0].accountId || pool[0].id);
      return this.accountManager.publicView(pool[0]);
    }
    const am = this.accountManager;
    const configured = am._cursors.get(providerId);
    const strategy = opts.strategy || (configured && configured.strategy) || am.defaultStrategy || 'priority';
    const sorted = [...pool].sort((a, b) => (a.priority || 100) - (b.priority || 100));
    let selected;
    switch (strategy) {
      case 'round-robin': {
        const cursor = am._cursors.get(providerId) || {};
        const lastId = cursor.lastAccountId || null;
        let idx = 0;
        if (lastId) {
          const found = sorted.findIndex((a) => (a.accountId || a.id) === lastId);
          if (found !== -1) idx = (found + 1) % sorted.length;
        }
        selected = sorted[idx];
        cursor.lastAccountId = selected.accountId || selected.id;
        delete cursor.lastIdx;
        am._cursors.set(providerId, cursor);
        break;
      }
      case 'random':
        selected = sorted[Math.floor(Math.random() * sorted.length)];
        break;
      case 'least-used': {
        const scored = sorted.map((a) => {
          const h = am._health.get(a.accountId || a.id);
          return { account: a, used: h ? (h.successCount || 0) + (h.failureCount || 0) : 0 };
        });
        scored.sort((a, b) => a.used - b.used);
        selected = scored[0].account;
        break;
      }
      case 'weighted': {
        const rawW = sorted.map((a) => (typeof a.weight === 'number' && a.weight > 0 ? a.weight : 0));
        const anyPos = rawW.some((w) => w > 0);
        const weights = anyPos ? rawW : sorted.map(() => 1);
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        for (let i = 0; i < sorted.length; i += 1) { r -= weights[i]; if (r < 0) { selected = sorted[i]; break; } }
        if (!selected) selected = sorted[sorted.length - 1];
        break;
      }
      case 'fastest':
      case 'fastest-response':
      case 'lowest-latency': {
        const scored = sorted.map((a) => ({ account: a, latency: am._health.get(a.accountId || a.id)?.lastLatencyMs }));
        if (!scored.some((s) => typeof s.latency === 'number')) selected = sorted[0];
        else {
          scored.sort((a, b) => (typeof a.latency === 'number' ? a.latency : Infinity) - (typeof b.latency === 'number' ? b.latency : Infinity));
          selected = scored[0].account;
        }
        break;
      }
      case 'priority':
      default:
        selected = sorted[0];
        break;
    }
    if (selected) {
      am.recordUsage(selected.accountId || selected.id);
      return am.publicView(selected);
    }
    return null;
  }

  /**
   * Resolve the runtime authentication material for a provider request.
   *
   * This is the official resolver the RequestExecutor uses to obtain the
   * credential for an upstream call. It selects the best connection via the
   * routing strategy (selectConnection → AccountManager), auto-refreshes an
   * expired credential, decrypts it through the ConnectionRegistry, and maps
   * it to transport-level auth (an API key or ready-to-send headers).
   *
   * Supported auth types: api-key, oauth, device-code, browser-login,
   * session, and custom (best-effort field detection).
   *
   * Returns `null` when the provider has no usable connection — the caller
   * then falls back to the legacy ApiKeyManager path (full backward compat).
   *
   * The returned object never leaves the gateway: it is handed directly to
   * the HttpClient which applies it to the outbound request. Secrets are
   * NEVER logged or returned to the client.
   *
   * @param {string} providerId
   * @param {object} [opts] - { strategy, model }
   * @returns {Promise<{connectionId:string, providerId:string, authType:string,
   *   apiKey:(string|null), headers:object}|null>}
   */
  async resolveRuntimeAuth(providerId, opts = {}) {
    if (!providerId || !this.registry) return null;

    // 1. Pick the best connection using the official selection mechanism
    //    (priority / round-robin / weighted / least-used / fastest / random).
    let selected = null;
    try {
      selected = await this.selectConnection(providerId, opts);
    } catch (_) {
      selected = null;
    }
    if (!selected) return null;

    const accountId = selected.id || selected.accountId;
    if (!accountId) return null;

    // 2. Load the raw (encrypted) account and refresh it when expired.
    let raw = await this.registry._loadAccount(accountId).catch(() => null);
    if (!raw) return null;

    if (raw.expiresAt && Date.now() >= raw.expiresAt) {
      try {
        await this.registry.refresh(accountId);
        raw = (await this.registry._loadAccount(accountId).catch(() => null)) || raw;
      } catch (err) {
        this._audit('refresh-on-resolve-failed', accountId, providerId, { error: err.message });
      }
    }

    // 3. Decrypt the credential in-memory (never persisted plaintext).
    const plain = this.registry._plain(raw);
    const cred = (plain && plain.credential) || {};
    const authType = (plain && plain.authType) || selected.authType || 'api-key';

    const headers = {};
    let apiKey = null;

    switch (authType) {
      case 'api-key':
        apiKey = cred.apiKey || cred.key || cred.token || null;
        break;
      case 'oauth':
      case 'device-code': {
        const tokenType = cred.tokenType || 'Bearer';
        if (cred.accessToken) headers.Authorization = `${tokenType} ${cred.accessToken}`;
        break;
      }
      case 'browser-login':
        if (cred.cookies) headers.Cookie = cred.cookies;
        else if (cred.sessionToken) headers.Authorization = `Bearer ${cred.sessionToken}`;
        break;
      case 'session':
        if (cred.session) headers.Cookie = cred.session;
        break;
      default: {
        // Custom / unknown auth type — best-effort field detection.
        if (cred.apiKey) apiKey = cred.apiKey;
        else if (cred.accessToken) headers.Authorization = `${cred.tokenType || 'Bearer'} ${cred.accessToken}`;
        else if (cred.cookies) headers.Cookie = cred.cookies;
        else if (cred.session) headers.Cookie = cred.session;
        if (cred.headers && typeof cred.headers === 'object') Object.assign(headers, cred.headers);
      }
    }

    // No usable credential material — fall back to legacy path.
    if (!apiKey && Object.keys(headers).length === 0) return null;

    return {
      connectionId: accountId,
      providerId,
      authType,
      apiKey,
      headers,
      connectionName: selected.displayName || selected.name || accountId,
      strategy: this.accountManager && typeof this.accountManager.getStrategy === 'function'
        ? this.accountManager.getStrategy(providerId) : null,
    };
  }

  /**
   * Report the outcome of a request that used a resolved connection so the
   * AccountManager can track per-connection health (latency, success/failure)
   * for health-aware selection strategies. Best-effort; never throws.
   * @param {string} connectionId
   * @param {object} result - { ok:boolean, latencyMs?:number, error?:string }
   */
  reportResult(connectionId, result = {}) {
    if (!connectionId || !this.accountManager) return;
    try {
      if (result.ok) {
        this.accountManager.recordUsage(connectionId, { latencyMs: result.latencyMs });
      } else {
        this.accountManager.recordFailure(connectionId, result.error || 'request failed');
      }
    } catch (_) { /* never block */ }
  }

  // ---------------------------------------------------------------
  // Audit log (get recent events)
  // ---------------------------------------------------------------

  getAuditLog(limit = 50) {
    return []; // stub — real audit would read from a persisted log.
  }
}

module.exports = ConnectionManager;
