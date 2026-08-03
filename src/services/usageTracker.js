/**
 * UsageTracker
 *
 * Tracks per-API-key usage statistics:
 *   - total requests
 *   - total tokens (prompt + completion)
 *   - per-provider request counts
 *   - per-model request counts
 *   - last used timestamp
 *   - first-seen (created) timestamp
 *
 * The tracker is keyed by the API key id (not the raw key value) so that
 * usage data survives key rotation without leaking the secret. It is
 * populated by the auth middleware (request count) and the
 * RequestExecutor (token/provider/model counts after a successful
 * response).
 *
 * When a storageProvider is given, all state is persisted through it
 * (Redis or MemoryStorage). Without a storageProvider, the default
 * in-memory Map is used (pure backward compat).
 */
class UsageTracker {
  /**
   * @param {object} [opts]
   * @param {object} [opts.storageProvider] - optional StorageProvider instance
   */
  constructor(opts = {}) {
    this._store = opts.storageProvider || null;
    this.statsByKey = new Map();
  }

  /**
   * Ensure a stats record exists for a key id. Creates one on first access.
   * @param {string} keyId
   * @returns {object}
   * @private
   */
  _ensure(keyId) {
    if (!this.statsByKey.has(keyId)) {
      this.statsByKey.set(keyId, {
        keyId,
        totalRequests: 0,
        totalTokens: 0,
        providerUsage: {},
        modelUsage: {},
        lastUsed: null,
        createdAt: Math.floor(Date.now() / 1000),
      });
      // Persist initial record when storage is available
      if (this._store) {
        this._store.hset(`usage:${keyId}`, this.statsByKey.get(keyId)).catch(() => {});
      }
    }
    return this.statsByKey.get(keyId);
  }

  /**
   * Persist a specific field change to storage (fire-and-forget).
   * @param {string} keyId
   * @param {object} updates
   * @private
   */
  _persist(keyId, updates) {
    if (this._store) {
      this._store.hset(`usage:${keyId}`, updates).catch(() => {});
    }
  }

  /**
   * Record a request for a key. Called by the auth middleware on every
   * authenticated request (before the response is known).
   * @param {string} keyId
   */
  recordRequest(keyId) {
    if (!keyId) return;
    const stats = this._ensure(keyId);
    stats.totalRequests += 1;
    stats.lastUsed = Math.floor(Date.now() / 1000);
    this._persist(keyId, { totalRequests: stats.totalRequests, lastUsed: stats.lastUsed });
  }

  /**
   * Record usage details after a successful provider response. Called by
   * the RequestExecutor (or a post-response hook) with the token counts,
   * provider id, and model from the response.
   *
   * @param {string} keyId
   * @param {object} detail
   * @param {string} [detail.providerId]
   * @param {string} [detail.model]
   * @param {number} [detail.totalTokens]
   */
  recordUsage(keyId, detail = {}) {
    if (!keyId) return;
    const stats = this._ensure(keyId);
    stats.lastUsed = Math.floor(Date.now() / 1000);

    if (typeof detail.totalTokens === 'number' && detail.totalTokens > 0) {
      stats.totalTokens += detail.totalTokens;
    }

    if (detail.providerId) {
      stats.providerUsage[detail.providerId] = (stats.providerUsage[detail.providerId] || 0) + 1;
    }

    if (detail.model) {
      stats.modelUsage[detail.model] = (stats.modelUsage[detail.model] || 0) + 1;
    }

    this._persist(keyId, {
      totalTokens: stats.totalTokens,
      lastUsed: stats.lastUsed,
      providerUsage: { ...stats.providerUsage },
      modelUsage: { ...stats.modelUsage },
    });
  }

  /**
   * Get the usage stats for a key id. Returns null when the key has never
   * been seen.
   * @param {string} keyId
   * @returns {object|null}
   */
  getUsage(keyId) {
    return this.statsByKey.get(keyId) || null;
  }

  /**
   * Get usage stats for all keys.
   * @returns {Array<object>}
   */
  getAllUsage() {
    return [...this.statsByKey.values()];
  }

  /**
   * Reset all stats.
   */
  reset() {
    this.statsByKey.clear();
    if (this._store) {
      this._store.flush().catch(() => {});
    }
  }
}

module.exports = UsageTracker;
