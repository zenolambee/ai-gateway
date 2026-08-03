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
    // Per-provider account selection cursors for round-robin
    this._cursors = new Map(); // providerId -> { lastIdx, strategy }
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
      await this.registry._saveAccount(enhanced, enhanced.authType);
    }
    this._accounts.set(id, enhanced);
    return this.publicView(enhanced);
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
   * @param {string} providerId
   * @param {object} [opts]
   * @param {string} [opts.strategy='priority'] - priority|fastest|weighted|round-robin|least-used|random
   * @param {string} [opts.model] - context for strategy
   * @returns {Promise<object|null>} selected account (public view)
   */
  async selectAccount(providerId, opts = {}) {
    const accounts = await this.getAvailableAccounts(providerId);
    if (accounts.length === 0) return null;
    const strategy = opts.strategy || 'priority';
    let selected;

    switch (strategy) {
      case 'fastest': {
        // Lowest latency first.
        const scored = accounts.map((a) => ({
          account: a,
          latency: this._health.get(a.id)?.lastLatencyMs || Infinity,
        }));
        scored.sort((a, b) => a.latency - b.latency);
        selected = scored[0].account;
        break;
      }
      case 'weighted': {
        // Weighted random selection.
        const total = accounts.reduce((s, a) => s + (a.weight || 1), 0);
        let r = Math.random() * total;
        for (const a of accounts) {
          r -= a.weight || 1;
          if (r <= 0) { selected = a; break; }
        }
        if (!selected) selected = accounts[accounts.length - 1];
        break;
      }
      case 'round-robin': {
        const cursor = this._cursors.get(providerId) || { lastIdx: -1 };
        cursor.lastIdx = (cursor.lastIdx + 1) % accounts.length;
        this._cursors.set(providerId, cursor);
        selected = accounts[cursor.lastIdx];
        break;
      }
      case 'least-used': {
        // Lowest usage count first.
        const scored = accounts.map((a) => ({
          account: a,
          used: this._health.get(a.id)?.successCount || 0,
        }));
        scored.sort((a, b) => a.used - b.used);
        selected = scored[0].account;
        break;
      }
      case 'random': {
        selected = accounts[Math.floor(Math.random() * accounts.length)];
        break;
      }
      case 'priority':
      default: {
        // Already sorted by priority.
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
}

module.exports = AccountManager;
