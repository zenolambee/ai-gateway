const logger = require('../utils/logger');

/**
 * AccountManager
 *
 * Universal provider account manager. Wraps ConnectionRegistry with:
 *   - Enhanced account schema (displayName, email, enabled, priority, weight,
 *     tags, quota, lastUsed, latency)
 *   - Account selection with routing strategies per provider
 *   - Auto-refresh fallback chain
 *   - Health tracking per account (latency, success rate, last error)
 *   - Masking for credentials returned to the dashboard
 *
 * Every account is stored through the ConnectionRegistry (encrypted via
 * EncryptionService) — we never expose raw credentials via the API.
 *
 * The AccountManager drives account-level routing: the executor delegates
 * account selection here when the provider has SDK adapters with connected
 * accounts. Legacy providers continue using the existing ApiKeyManager
 * key-rotation (full backward compatibility).
 */
class AccountManager {
  /**
   * @param {object} opts
   * @param {ConnectionRegistry} [opts.registry]
   * @param {object} [opts.providerManager]
   * @param {object} [opts.httpClient]
   */
  constructor(opts = {}) {
    this.registry = opts.registry || null;
    this.providerManager = opts.providerManager || null;
    this.httpClient = opts.httpClient || null;
    // Global default connection selection strategy (config/routing.json
    // `connectionStrategy`). Per-provider overrides live in this._cursors.
    this.defaultStrategy = typeof opts.defaultStrategy === 'string' ? opts.defaultStrategy : 'priority';
    // Per-provider account selection cursors for round-robin + the
    // per-provider strategy override: providerId -> { lastAccountId, strategy }
    this._cursors = new Map();
    // Account health tracking
    this._health = new Map(); // accountId -> { latency, successCount, failureCount, lastError, lastUsed }
    // Raw account cache (enhanced fields preserved)
    this._accounts = new Map(); // accountId -> enhanced raw account
  }

  // ---------------------------------------------------------------
  // Account CRUD (wraps ConnectionRegistry with enhanced schema)
  // ---------------------------------------------------------------

  /**
   * Add an account. Passes through to ConnectionRegistry.connect() with
   * the enhanced fields.
   * @param {object} cfg
   * @returns {Promise<object>} public account view
   */
  async addAccount(cfg) {
    if (!this.registry) throw new Error('AccountManager: no registry');
    const accountId = cfg.accountId || cfg.id || cfg.providerId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    // Pass through ALL config fields to the registry so auth-type-specific
    // fields (cookies, deviceCode, accessToken, refreshToken, etc.) reach the adapter.
    const connectConfig = {
      providerId: cfg.providerId,
      accountId,
      authType: cfg.authType || 'api-key',
      name: cfg.displayName || cfg.name || cfg.providerId,
      apiKey: cfg.apiKey,
      accessToken: cfg.accessToken,
      refreshToken: cfg.refreshToken,
      cookies: cfg.cookies,
      sessionToken: cfg.sessionToken,
      deviceCode: cfg.deviceCode,
      verificationUri: cfg.verificationUri,
      scope: cfg.scope,
      meta: cfg.meta || null,
    };
    const account = await this.registry.connect(connectConfig);
    const id = account.accountId || accountId;
    // Persist enhanced fields that the adapter doesn't preserve.
    const enhanced = {
      accountId: id,
      providerId: cfg.providerId,
      authType: cfg.authType || 'api-key',
      name: cfg.displayName || account.name,
      apiKey: cfg.apiKey,
      accessToken: cfg.accessToken,
      refreshToken: cfg.refreshToken,
      state: account.state || 'connected',
      connectedAt: account.connectedAt || Date.now(),
      expiresAt: account.expiresAt || null,
      displayName: cfg.displayName || account.name,
      email: cfg.email,
      enabled: cfg.enabled !== false,
      priority: typeof cfg.priority === 'number' ? cfg.priority : 100,
      weight: typeof cfg.weight === 'number' && cfg.weight > 0 ? cfg.weight : 1,
      tags: Array.isArray(cfg.tags) ? cfg.tags : [],
      quota: cfg.quota || null,
    };
    // Merge back through the registry (persists with encrypted credential).
    if (this.registry._saveAccount) {
      // Preserve credential from the registry's connect result.
      const raw = this.registry.accounts.get(id);
      if (raw && raw.credential) {
        enhanced.credential = raw.credential;
      }
      // SECURITY: never persist plaintext secrets at the account top level —
      // the credential object is encrypted by _saveAccount, but stray plain
      // fields (apiKey/accessToken/refreshToken/sessionToken/cookies) would
      // otherwise be written to storage verbatim. The in-memory enhanced copy
      // keeps the key so publicView() can render a masked preview.
      const toPersist = { ...enhanced };
      for (const secretField of ['apiKey', 'accessToken', 'refreshToken', 'sessionToken', 'cookies', 'deviceCode']) {
        delete toPersist[secretField];
      }
      await this.registry._saveAccount(toPersist, enhanced.authType);
    }
    this._accounts.set(id, enhanced);
    return this.publicView(enhanced);
  }

  /**
   * Remove an account from the enhanced in-memory index. Called when a
   * connection is disconnected through the ConnectionManager/registry so
   * selection strategies never see stale entries.
   * @param {string} accountId
   */
  removeAccount(accountId) {
    this._accounts.delete(accountId);
    this._health.delete(accountId);
  }

  /**
   * Return a redacted (masked) view of an account for the dashboard.
   * Never exposes raw apiKey/accessToken/refreshToken.
   * @param {object} raw - raw account object (with apiKey/accessToken fields)
   * @returns {object}
   */
  publicView(raw) {
    if (!raw) return null;
    const id = raw.accountId || raw.id;
    // Mask sensitive fields
    let apiKey = raw.apiKey || null;
    let accessToken = raw.accessToken || null;
    if (apiKey && typeof apiKey === 'string') {
      apiKey = apiKey.length > 8 ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '****';
    }
    if (accessToken) accessToken = accessToken.length > 8 ? accessToken.slice(0, 4) + '...' + accessToken.slice(-4) : '****';
    const health = id ? this._health.get(id) : null;
    return {
      id,
      provider: raw.providerId,
      displayName: raw.displayName || raw.name,
      authType: raw.authType,
      email: raw.email || null,
      apiKey,
      accessToken,
      refreshToken: '****',
      expiresAt: raw.expiresAt || null,
      status: raw.state || raw.status || 'connected',
      enabled: raw.enabled !== false,
      priority: typeof raw.priority === 'number' ? raw.priority : 100,
      weight: typeof raw.weight === 'number' ? raw.weight : 1,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      lastUsed: raw.lastUsed || raw.lastRefreshedAt || null,
      latency: health?.lastLatencyMs || null,
      quota: raw.quota || null,
      connectedAt: raw.connectedAt || null,
    };
  }

  /**
   * List all accounts with redacted views.
   * @param {string} [providerId] - filter
   * @returns {Promise<Array<object>>}
   */
  async listAccounts(providerId) {
    // Reconcile with the registry (source of truth) so connections created
    // via ConnectionRegistry.connect() or removed via disconnect() are
    // reflected here without duplicating storage. The registry reconciles
    // its own map against storage first.
    if (this.registry && this.registry.accounts) {
      if (typeof this.registry.listAccounts === 'function') {
        try { await this.registry.listAccounts(); } catch (_) { /* keep view */ }
      }
      for (const [accountId, raw] of this.registry.accounts) {
        if (!this._accounts.has(accountId)) {
          this._accounts.set(accountId, {
            ...raw,
            enabled: raw.enabled !== false,
            priority: typeof raw.priority === 'number' ? raw.priority : 100,
            weight: typeof raw.weight === 'number' && raw.weight > 0 ? raw.weight : 1,
          });
        }
      }
      for (const accountId of [...this._accounts.keys()]) {
        if (!this.registry.accounts.has(accountId)) this._accounts.delete(accountId);
      }
    }
    const values = [...this._accounts.values()];
    const filtered = providerId ? values.filter((a) => a.providerId === providerId) : values;
    return filtered.map((a) => this.publicView(a));
  }

  /**
   * Toggle account enabled/disabled.
   * @param {string} accountId
   * @param {boolean} enabled
   * @returns {Promise<object|null>}
   */
  async setEnabled(accountId, enabled) {
    if (!this.registry) return null;
    const raw = await this.registry.status(accountId).catch(() => null);
    if (!raw) return null;
    await this.registry._saveAccount({ ...raw, enabled }, raw.authType);
    return this.publicView({ ...raw, enabled });
  }

  /**
   * Record a usage event on an account (for lastUsed + health).
   * @param {string} accountId
   * @param {object} [opts] - { latencyMs }
   */
  recordUsage(accountId, opts = {}) {
    const h = this._health.get(accountId) || { successCount: 0, failureCount: 0, lastError: null, lastUsed: null, lastLatencyMs: null };
    h.lastUsed = Date.now();
    if (typeof opts.latencyMs === 'number') {
      h.lastLatencyMs = opts.latencyMs;
    }
    h.successCount += 1;
    this._health.set(accountId, h);
  }

  /**
   * Record a failure on an account.
   * @param {string} accountId
   * @param {string} [error]
   */
  recordFailure(accountId, error) {
    const h = this._health.get(accountId) || { successCount: 0, failureCount: 0, lastError: null, lastUsed: null, lastLatencyMs: null };
    h.failureCount = (h.failureCount || 0) + 1;
    h.lastError = error || 'unknown';
    this._health.set(accountId, h);
  }

  // ---------------------------------------------------------------
  // Account selection with routing strategies
  // ---------------------------------------------------------------

  /**
   * Get all enabled, non-expired accounts for a provider.
   * @param {string} providerId
   * @returns {Promise<Array<object>>}
   */
  async getAvailableAccounts(providerId) {
    await this.listAccounts(); // refresh internal cache
    const values = [...this._accounts.values()];
    return values
      .filter((a) => a.providerId === providerId && a.enabled !== false && a.state !== 'expired' && a.state !== 'disconnected')
      .sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  /**
   * Select the next best account for a provider given a strategy.
   *
   * The effective strategy is resolved from: the explicit `opts.strategy`
   * (per-request override) → the strategy configured for this provider via
   * the admin routing API (stored in this._cursors[providerId].strategy) →
   * the global default connection strategy (this.defaultStrategy, from
   * config/routing.json `connectionStrategy`) → 'priority'.
   *
   * @param {string} providerId
   * @param {object} [opts]
   * @param {string} [opts.strategy] - per-request strategy override
   * @param {string} [opts.model] - context for strategy
   * @returns {Promise<object|null>} selected account (public view)
   */
  async selectAccount(providerId, opts = {}) {
    const accounts = await this.getAvailableAccounts(providerId);
    if (accounts.length === 0) return null;
    const configured = this._cursors.get(providerId);
    const strategy = opts.strategy
      || (configured && configured.strategy)
      || this.defaultStrategy
      || 'priority';
    let selected;

    switch (strategy) {
      case 'fastest':
      case 'fastest-response':
      case 'lowest-latency': {
        // Lowest latency first. Accounts with no recorded latency are
        // preferred over known-slow accounts but lose to known-fast ones.
        const scored = accounts.map((a) => ({
          account: a,
          latency: this._health.get(a.accountId || a.id)?.lastLatencyMs,
        }));
        const known = scored.filter((s) => typeof s.latency === 'number');
        if (known.length === 0) {
          // No latency data yet — safe fallback to priority order.
          selected = accounts[0];
        } else {
          scored.sort((a, b) => {
            const la = typeof a.latency === 'number' ? a.latency : Infinity;
            const lb = typeof b.latency === 'number' ? b.latency : Infinity;
            return la - lb;
          });
          selected = scored[0].account;
        }
        break;
      }
      case 'weighted': {
        // Weighted random selection. Connections with weight 0 never win
        // unless every connection has weight 0 (then all share weight 1).
        const rawWeights = accounts.map((a) => (typeof a.weight === 'number' && a.weight > 0 ? a.weight : 0));
        const anyPositive = rawWeights.some((w) => w > 0);
        const weights = anyPositive ? rawWeights : accounts.map(() => 1);
        const total = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * total;
        for (let i = 0; i < accounts.length; i += 1) {
          r -= weights[i];
          if (r < 0) { selected = accounts[i]; break; }
        }
        if (!selected) selected = accounts[accounts.length - 1];
        break;
      }
      case 'round-robin': {
        // Stateful round-robin anchored on the ACCOUNT IDENTITY, not the
        // list position. The cursor remembers the last served account id, so
        // when a connection is disabled the remaining connections keep their
        // stable rotation (A(disabled B)C → A → C → A → C) instead of
        // re-serving the head of the shrunken list.
        //
        // Concurrency: the cursor read + advance + write happen in the same
        // synchronous block; Node's event loop cannot interleave another
        // request between them, so concurrent requests rotate correctly.
        const cursor = this._cursors.get(providerId) || { lastAccountId: null };
        const lastId = cursor.lastAccountId || cursor.lastId || null;
        let startIdx = 0;
        if (lastId) {
          const found = accounts.findIndex((a) => (a.accountId || a.id) === lastId);
          if (found !== -1) startIdx = (found + 1) % accounts.length;
        }
        selected = accounts[startIdx];
        cursor.lastAccountId = selected.accountId || selected.id;
        delete cursor.lastIdx; // legacy field — superseded by lastAccountId
        this._cursors.set(providerId, cursor);
        break;
      }
      case 'least-used': {
        // Lowest usage count first (successCount + failureCount from the
        // existing health tracking — no new metrics system).
        const scored = accounts.map((a) => {
          const h = this._health.get(a.accountId || a.id);
          const used = h ? (h.successCount || 0) + (h.failureCount || 0) : 0;
          return { account: a, used };
        });
        scored.sort((a, b) => {
          if (a.used !== b.used) return a.used - b.used;
          return (a.account.priority || 100) - (b.account.priority || 100);
        });
        selected = scored[0].account;
        break;
      }
      case 'random': {
        selected = accounts[Math.floor(Math.random() * accounts.length)];
        break;
      }
      case 'priority':
      default: {
        // Already sorted by priority (stable) — lowest value first.
        selected = accounts[0];
        break;
      }
    }

    if (selected) {
      this.recordUsage(selected.accountId || selected.id);
      return this.publicView(selected);
    }
    return null;
  }

  /**
   * Try to select an account, auto-refreshing if expired, then fallback
   * to the next available account if refresh fails.
   * @param {string} providerId
   * @param {object} [opts]
   * @returns {Promise<object|null>}
   */
  async selectWithFallback(providerId, opts = {}) {
    const accounts = await this.getAvailableAccounts(providerId);
    const candidates = accounts.filter((a) => a.state !== 'disconnected');

    for (let attempt = 0; attempt < Math.min(candidates.length, 3); attempt++) {
      const account = candidates[attempt];
      if (account.state === 'expired' && this.registry) {
        try {
          const refreshed = await this.registry.refresh(account.accountId || account.id);
          if (refreshed && refreshed.state !== 'expired' && refreshed.state !== 'disconnected') {
            this.recordUsage(account.accountId || account.id);
            return this.publicView({ ...account, ...refreshed });
          }
        } catch (err) {
          this.recordFailure(account.accountId || account.id, err.message);
          continue;
        }
      }
      if (account.state !== 'expired' && account.state !== 'disconnected') {
        this.recordUsage(account.accountId || account.id);
        return this.publicView(account);
      }
    }
    return null;
  }

  /** Get account health metrics for the dashboard. */
  getHealth() {
    const out = {};
    for (const [id, h] of this._health) {
      out[id] = {
        lastUsed: h.lastUsed,
        lastLatencyMs: h.lastLatencyMs,
        successCount: h.successCount,
        failureCount: h.failureCount,
        lastError: h.lastError,
        successRate: (h.successCount + h.failureCount) > 0
          ? Math.round((h.successCount / (h.successCount + h.failureCount)) * 10000) / 100
          : 100,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Routing configuration (admin API / hot reload)
  // ---------------------------------------------------------------

  /**
   * Set the global default connection selection strategy.
   * @param {string} strategyId
   */
  setDefaultStrategy(strategyId) {
    if (typeof strategyId === 'string' && strategyId) this.defaultStrategy = strategyId;
  }

  /**
   * Get the effective connection selection strategy for a provider
   * (per-provider override → global default).
   * @param {string} providerId
   * @returns {string}
   */
  getStrategy(providerId) {
    const cfg = this._cursors.get(providerId);
    return (cfg && cfg.strategy) || this.defaultStrategy || 'priority';
  }

  /**
   * Set (or clear) the per-provider connection selection strategy.
   * @param {string} providerId
   * @param {string|null} strategyId - null clears the override
   */
  setProviderStrategy(providerId, strategyId) {
    if (!providerId) return;
    const cur = this._cursors.get(providerId) || {};
    if (strategyId === null || strategyId === undefined) delete cur.strategy;
    else cur.strategy = strategyId;
    this._cursors.set(providerId, cur);
  }

  /**
   * Return per-provider strategy overrides for the admin API.
   * @returns {object} providerId -> strategyId
   */
  getProviderStrategies() {
    const out = {};
    for (const [pid, cfg] of this._cursors) {
      if (cfg && cfg.strategy) out[pid] = cfg.strategy;
    }
    return out;
  }
}

module.exports = AccountManager;
