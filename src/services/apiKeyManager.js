const logger = require('../utils/logger');
const { getStrategy: getKeySelectionStrategy } = require('./keySelectionStrategy');

/**
 * API key status codes.
 */
const KeyStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  DISABLED: 'DISABLED',
  COOLDOWN: 'COOLDOWN',
});

/**
 * Default cooldown durations (in milliseconds) per error category.
 *
 * These can be overridden per-call via reportFailure options.
 */
const DEFAULT_COOLDOWNS_MS = Object.freeze({
  RATE_LIMITED: 60_000,
  SERVER_ERROR: 5_000,
  NETWORK_ERROR: 1_000,
  TIMEOUT: 1_000,
  QUOTA_EXCEEDED: 0,    // permanent until manual enable
  UNAUTHORIZED: 0,      // permanent until manual enable
  UNKNOWN: 1_000,
});

/**
 * Number of consecutive failures that must occur before a transient error
 * triggers a cooldown. This allows the RequestExecutor's retry loop to reuse
 * the same key across a single logical request instead of immediately
 * exhausting all keys on the first failure.
 */
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Translate a normalized HTTP error `info.code` (from httpClientError.js)
 * into one of the cooldown categories understood by ApiKeyManager.
 *
 * @param {string} errorCode - ErrorCode value
 * @returns {string} cooldown category
 */
function errorCodeToCategory(errorCode) {
  switch (errorCode) {
    case 'PROVIDER_RATE_LIMITED': return 'RATE_LIMITED';
    case 'PROVIDER_UNAUTHORIZED':
    case 'PROVIDER_FORBIDDEN':
      return 'UNAUTHORIZED';
    case 'PROVIDER_SERVICE_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_SERVER_ERROR':
    case 'PROVIDER_BAD_GATEWAY':
      return 'SERVER_ERROR';
    case 'PROVIDER_CONNECTION_REFUSED':
    case 'PROVIDER_DNS_ERROR':
    case 'PROVIDER_NETWORK_ERROR':
      return 'NETWORK_ERROR';
    case 'PROVIDER_TIMEOUT': return 'TIMEOUT';
    default: return 'UNKNOWN';
  }
}

/**
 * Mask a key for safe logging. Shows the last 4 characters only.
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
  if (!key || typeof key !== 'string') return '<none>';
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

/**
 * Build a fresh per-key record.
 *
 * @param {string} providerId
 * @param {string} value - the actual API key string
 * @param {object} [meta] - optional key metadata: { priority, weight }
 * @returns {object}
 */
function createKeyRecord(providerId, value, meta = {}) {
  return {
    providerId,
    value,
    status: KeyStatus.ACTIVE,
    // optional per-key metadata (used by priority / weighted strategies)
    priority: typeof meta.priority === 'number' ? meta.priority : 0,
    weight: typeof meta.weight === 'number' && meta.weight > 0 ? meta.weight : 1,
    // statistics
    stats: {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastUsed: null,
      lastError: null,
      // health metrics (Sprint 9 additions)
      totalTokens: 0,
      latencySum: 0,
      latencyCount: 0,
      averageLatencyMs: 0,
      lastSuccess: null,
      lastFailure: null,
    },
    cooldownUntil: null,
  };
}

/**
 * ApiKeyManager
 *
 * Owns the lifecycle of every API key for every provider. Keys are loaded
 * from provider configuration (provider.apiKeys) and the manager handles:
 *
 *   - round-robin selection of the next available (ACTIVE) key
 *   - temporary disabling of keys on failure (cooldown)
 *   - automatic re-enabling of keys once their cooldown expires
 *   - permanent disabling on auth/quota errors (until manual re-enable)
 *   - per-key statistics (requests, success, failure, last used, last error)
 *
 * The manager is intentionally in-memory only; state is not persisted. This
 * keeps the implementation simple and is sufficient for the current stage.
 *
 * The manager exposes a small service surface that the HttpClient (and later
 * Retry / Fallback layers) can call without knowing anything about the
 * underlying key storage or rotation policy.
 */
class ApiKeyManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.cooldownsMs] - override default cooldown durations
   * @param {number} [opts.failureThreshold] - consecutive failures before cooldown
   * @param {string} [opts.defaultStrategy] - default key selection strategy id
   */
  constructor(opts = {}) {
    // providerId -> array of key records
    this.keysByProvider = new Map();
    // providerId -> round-robin / strategy cursor
    this.cursorsByProvider = new Map();
    // providerId -> per-provider config (strategy, cooldowns, threshold)
    this.providerConfig = new Map();
    this.cooldownsMs = { ...DEFAULT_COOLDOWNS_MS, ...(opts.cooldownsMs || {}) };
    this.failureThreshold = opts.failureThreshold !== undefined
      ? opts.failureThreshold
      : DEFAULT_FAILURE_THRESHOLD;
    this.defaultStrategy = opts.defaultStrategy || 'round-robin';
    this.loaded = false;
  }

  /**
   * Load keys from an array of provider config objects.
   *
   * Each provider must have an `id` and (optionally) an `apiKeys` array of
   * strings OR objects ({ value, priority, weight }). Calling this method
   * resets any previously loaded keys for the given providers. Keys that
   * were not present in the new config are dropped; previously known keys
   * keep their stats if they still exist.
   *
   * Per-provider configuration is extracted from:
   *   - provider.keySelectionStrategy  : strategy id (default: round-robin)
   *   - provider.cooldownPolicy        : { RATE_LIMITED, SERVER_ERROR, ... }
   *   - provider.cooldownFailureThreshold : consecutive failures before cooldown
   *
   * @param {Array<object>} providers - normalized provider configs
   * @returns {ApiKeyManager} this (for chaining)
   */
  load(providers) {
    if (!Array.isArray(providers)) {
      logger.error('ApiKeyManager.load requires an array of providers');
      return this;
    }

    const next = new Map();
    const nextConfig = new Map();
    for (const p of providers) {
      if (!p || !p.id) continue;

      // Extract per-provider key selection strategy + cooldown overrides.
      const strategyId = (p.keySelectionStrategy && typeof p.keySelectionStrategy === 'string')
        ? p.keySelectionStrategy
        : this.defaultStrategy;
      const cooldownOverride = (p.cooldownPolicy && typeof p.cooldownPolicy === 'object')
        ? { ...this.cooldownsMs, ...p.cooldownPolicy }
        : null;
      const threshold = (typeof p.cooldownFailureThreshold === 'number')
        ? p.cooldownFailureThreshold
        : this.failureThreshold;
      nextConfig.set(p.id, { strategy: strategyId, cooldownsMs: cooldownOverride, failureThreshold: threshold });

      // Normalize keys: accept strings or { value, priority, weight } objects.
      const rawKeys = Array.isArray(p.apiKeys) ? p.apiKeys : [];
      const records = [];
      for (const entry of rawKeys) {
        if (!entry) continue;
        let value, meta;
        if (typeof entry === 'string') {
          value = entry;
          meta = {};
        } else if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
          value = entry.value;
          meta = { priority: entry.priority, weight: entry.weight };
        } else {
          continue;
        }
        const existing = this._findKeyRecord(p.id, value);
        if (existing) {
          // preserve stats/cooldown across reloads; refresh metadata
          if (meta.priority !== undefined) existing.priority = meta.priority;
          if (meta.weight !== undefined) existing.weight = meta.weight;
          records.push(existing);
        } else {
          records.push(createKeyRecord(p.id, value, meta));
        }
      }
      next.set(p.id, records);
    }

    this.keysByProvider = next;
    this.providerConfig = nextConfig;
    this.cursorsByProvider = new Map();
    this.loaded = true;

    logger.info('ApiKeyManager initialized', {
      providers: next.size,
      totalKeys: Array.from(next.values()).reduce((sum, arr) => sum + arr.length, 0),
    });

    return this;
  }

  /**
   * Get the configured key selection strategy id for a provider.
   * @param {string} providerId
   * @returns {string}
   */
  getStrategy(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && cfg.strategy) || this.defaultStrategy;
  }

  /**
   * Set the key selection strategy for a provider at runtime (admin API).
   * @param {string} providerId
   * @param {string} strategyId
   */
  setStrategy(providerId, strategyId) {
    const cfg = this.providerConfig.get(providerId) || {
      strategy: this.defaultStrategy,
      cooldownsMs: null,
      failureThreshold: this.failureThreshold,
    };
    cfg.strategy = strategyId || this.defaultStrategy;
    this.providerConfig.set(providerId, cfg);
  }

  /**
   * Get the cooldown configuration for a provider (merge of defaults +
   * per-provider overrides). Returns the default cooldowns when the
   * provider has no override.
   * @param {string} providerId
   * @returns {object}
   */
  _cooldownsFor(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && cfg.cooldownsMs) || this.cooldownsMs;
  }

  /**
   * Get the failure threshold for a provider (per-provider override or default).
   * @param {string} providerId
   * @returns {number}
   */
  _thresholdFor(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && typeof cfg.failureThreshold === 'number') ? cfg.failureThreshold : this.failureThreshold;
  }

  /**
   * Return the array of key records for a provider.
   * @param {string} providerId
   * @returns {Array<object>}
   * @private
   */
  _records(providerId) {
    return this.keysByProvider.get(providerId) || [];
  }

  /**
   * Find a key record by its value.
   * @param {string} providerId
   * @param {string} value
   * @returns {object|null}
   * @private
   */
  _findKeyRecord(providerId, value) {
    return this._records(providerId).find((r) => r.value === value) || null;
  }

  /**
   * Reconcile a single key record: if it is in COOLDOWN and the cooldown has
   * expired, transition it back to ACTIVE.
   * @param {object} record
   * @private
   */
  _reconcileCooldown(record) {
    if (record.status === KeyStatus.COOLDOWN && record.cooldownUntil !== null) {
      if (Date.now() >= record.cooldownUntil) {
        record.status = KeyStatus.ACTIVE;
        record.cooldownUntil = null;
        logger.info('API key re-enabled after cooldown', {
          providerId: record.providerId,
          key: maskKey(record.value),
        });
      }
    }
  }

  /**
   * Select the next ACTIVE key for a provider using the configured strategy.
   *
   * Side effects:
   *   - expired cooldowns are cleared (auto re-enable)
   *   - the strategy cursor is advanced (for round-robin)
   *   - the returned key's `stats.lastUsed` is updated
   *
   * Throws an AppError (503) when no ACTIVE key is available.
   *
   * @param {string} providerId
   * @returns {string} the raw API key string to use
   */
  getNextKey(providerId) {
    const records = this._records(providerId);

    if (records.length === 0) {
      const err = new Error(`No API keys configured for provider "${providerId}"`);
      err.statusCode = 503;
      err.info = { code: 'NO_API_KEYS', providerId };
      throw err;
    }

    // Reconcile cooldowns so cooled-down keys that have expired become
    // ACTIVE again before the strategy runs.
    for (const r of records) this._reconcileCooldown(r);

    // Filter to ACTIVE candidates (RATE_LIMITED keys are also skipped; they
    // are reactivated by reportSuccess or by an explicit enable call, since
    // the provider usually sends a Retry-After that we honour via cooldown).
    const candidates = records.filter((r) => r.status === KeyStatus.ACTIVE);

    if (candidates.length === 0) {
      const err = new Error(`All API keys for provider "${providerId}" are unavailable`);
      err.statusCode = 503;
      err.info = { code: 'ALL_KEYS_UNAVAILABLE', providerId };
      throw err;
    }

    // Resolve the configured strategy for this provider and apply it.
    const strategyId = this.getStrategy(providerId);
    const cursor = this.cursorsByProvider.get(providerId) || { lastIdx: -1, lastValue: null };
    let strategyFn;
    try {
      strategyFn = getKeySelectionStrategy(strategyId);
    } catch (err) {
      logger.warn('Unknown key selection strategy, falling back to round-robin', {
        providerId, strategy: strategyId, error: err.message,
      });
      strategyFn = getKeySelectionStrategy('round-robin');
    }

    let idx = -1;
    try {
      idx = strategyFn(candidates, cursor);
    } catch (err) {
      logger.warn('Key selection strategy failed, falling back to first candidate', {
        providerId, strategy: strategyId, error: err.message,
      });
      idx = 0;
    }
    if (idx < 0 || idx >= candidates.length) idx = 0;

    const selected = candidates[idx];
    // Update the cursor for the next call (round-robin uses lastValue).
    cursor.lastIdx = idx;
    cursor.lastValue = selected.value;
    this.cursorsByProvider.set(providerId, cursor);

    selected.stats.lastUsed = new Date().toISOString();
    selected.stats.totalRequests += 1;
    return selected.value;
  }

  /**
   * Report that a request using a key succeeded. Resets transient failure
   * state — if the key was in COOLDOWN due to a transient error it is moved
   * back to ACTIVE. Records latency and token usage for health-aware
   * strategies (least-used, fastest-response).
   *
   * @param {string} providerId
   * @param {string} key
   * @param {object} [detail] - { latencyMs, tokens }
   */
  reportSuccess(providerId, key, detail = {}) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return;
    record.stats.successCount += 1;
    record.stats.consecutiveFailures = 0;
    record.stats.lastSuccess = Date.now();
    if (typeof detail.latencyMs === 'number' && detail.latencyMs > 0) {
      record.stats.latencySum += detail.latencyMs;
      record.stats.latencyCount += 1;
      record.stats.averageLatencyMs = Math.round(record.stats.latencySum / record.stats.latencyCount);
    }
    if (typeof detail.tokens === 'number' && detail.tokens > 0) {
      record.stats.totalTokens += detail.tokens;
    }
    if (record.status === KeyStatus.COOLDOWN) {
      record.status = KeyStatus.ACTIVE;
      record.cooldownUntil = null;
    }
    // A successful request after a rate-limit also reactivates the key.
    if (record.status === KeyStatus.RATE_LIMITED) {
      record.status = KeyStatus.ACTIVE;
      record.cooldownUntil = null;
    }
  }

  /**
   * Report that a request using a key failed. Depending on the error category
   * the key may be temporarily cooled down or permanently disabled.
   *
   * Transient failures (server errors, timeouts, network issues) only trigger
   * a cooldown after `failureThreshold` consecutive failures, so that a
   * single transient blip does not exhaust the key pool during a retry loop.
   *
   * @param {string} providerId
   * @param {string} key
   * @param {Error} [error] - normalized AppError (with `info.code`)
   * @param {object} [opts]
   * @param {number} [opts.cooldownMs] - override cooldown duration for this call
   */
  reportFailure(providerId, key, error, opts = {}) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return;

    record.stats.failureCount += 1;
    record.stats.consecutiveFailures += 1;
    record.stats.lastFailure = Date.now();
    record.stats.lastError = {
      message: (error && error.message) || 'unknown error',
      code: (error && error.info && error.info.code) || null,
      at: new Date().toISOString(),
    };

    const category = errorCodeToCategory(error && error.info && error.info.code);

    // Permanent disables (until manual re-enable)
    if (category === 'UNAUTHORIZED') {
      record.status = KeyStatus.UNAUTHORIZED;
      record.cooldownUntil = null;
      logger.warn('API key marked UNAUTHORIZED', {
        providerId,
        key: maskKey(key),
      });
      return;
    }
    if (category === 'QUOTA_EXCEEDED') {
      record.status = KeyStatus.QUOTA_EXCEEDED;
      record.cooldownUntil = null;
      logger.warn('API key marked QUOTA_EXCEEDED', {
        providerId,
        key: maskKey(key),
      });
      return;
    }

    // Explicit status mirroring for rate-limited responses
    if (category === 'RATE_LIMITED') {
      record.status = KeyStatus.RATE_LIMITED;
    }

    // Cooldown for transient failures — only after reaching the threshold of
    // consecutive failures, so a single blip inside a retry loop does not
    // immediately make the key unavailable. Use the per-provider cooldown
    // durations and threshold when configured, else the global defaults.
    const providerCooldowns = this._cooldownsFor(providerId);
    const cooldownMs = opts.cooldownMs !== undefined
      ? opts.cooldownMs
      : providerCooldowns[category] !== undefined
        ? providerCooldowns[category]
        : providerCooldowns.UNKNOWN;

    const threshold = this._thresholdFor(providerId);
    if (cooldownMs > 0 && record.stats.consecutiveFailures >= threshold) {
      record.status = KeyStatus.COOLDOWN;
      record.cooldownUntil = Date.now() + cooldownMs;
      logger.warn('API key placed in cooldown', {
        providerId,
        key: maskKey(key),
        cooldownMs,
        category,
        consecutiveFailures: record.stats.consecutiveFailures,
      });
    }
  }

  /**
   * Manually disable a key (no cooldown — stays DISABLED until enableKey).
   * @param {string} providerId
   * @param {string} key
   */
  disableKey(providerId, key) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return false;
    record.status = KeyStatus.DISABLED;
    record.cooldownUntil = null;
    return true;
  }

  /**
   * Manually re-enable a previously disabled / cooled-down key.
   * @param {string} providerId
   * @param {string} key
   */
  enableKey(providerId, key) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return false;
    record.status = KeyStatus.ACTIVE;
    record.cooldownUntil = null;
    return true;
  }

  /**
   * Return a serializable snapshot of every key (masked) for a provider,
   * including its current status and statistics.
   *
   * @param {string} providerId
   * @returns {Array<object>}
   */
  getKeyStatus(providerId) {
    return this._records(providerId).map((r) => this._snapshot(r));
  }

  /**
   * Return a snapshot for every provider. Useful for diagnostics and, later,
   * a dashboard.
   * @returns {object} { [providerId]: Array<snapshot> }
   */
  getAllStatus() {
    const out = {};
    for (const [providerId, records] of this.keysByProvider.entries()) {
      out[providerId] = records.map((r) => this._snapshot(r));
    }
    return out;
  }

  /**
   * Build a safe, serializable snapshot of a key record.
   * @param {object} record
   * @returns {object}
   * @private
   */
  _snapshot(record) {
    const s = record.stats;
    const total = s.successCount + s.failureCount;
    return {
      providerId: record.providerId,
      key: maskKey(record.value),
      status: record.status,
      priority: record.priority,
      weight: record.weight,
      stats: {
        ...s,
        successRate: total > 0 ? Math.round((s.successCount / total) * 10000) / 100 : 100,
        errorRate: total > 0 ? Math.round((s.failureCount / total) * 10000) / 100 : 0,
      },
      cooldownUntil: record.cooldownUntil !== null
        ? new Date(record.cooldownUntil).toISOString()
        : null,
      lastSuccess: s.lastSuccess ? new Date(s.lastSuccess).toISOString() : null,
      lastFailure: s.lastFailure ? new Date(s.lastFailure).toISOString() : null,
    };
  }

  /**
   * Return a per-key health snapshot for a provider. Includes latency,
   * success rate, error rate, cooldown status, request count, and token
   * usage — for the admin dashboard.
   * @param {string} providerId
   * @returns {Array<object>}
   */
  getKeyHealth(providerId) {
    return this._records(providerId).map((r) => this._snapshot(r));
  }

  /**
   * Return per-key health for every provider (admin API).
   * @returns {object} { [providerId]: Array<snapshot> }
   */
  getAllKeyHealth() {
    const out = {};
    for (const [providerId, records] of this.keysByProvider) {
      out[providerId] = records.map((r) => this._snapshot(r));
    }
    return out;
  }
}

module.exports = ApiKeyManager;
module.exports.KeyStatus = KeyStatus;
module.exports.DEFAULT_COOLDOWNS_MS = DEFAULT_COOLDOWNS_MS;
module.exports.DEFAULT_FAILURE_THRESHOLD = DEFAULT_FAILURE_THRESHOLD;
module.exports.errorCodeToCategory = errorCodeToCategory;
module.exports.maskKey = maskKey;
