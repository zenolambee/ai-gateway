const logger = require('../utils/logger');
const { getStrategy: getKeySelectionStrategy } = require('./keySelectionStrategy');
const crypto = require('crypto');

const KeyStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  DISABLED: 'DISABLED',
  COOLDOWN: 'COOLDOWN',
});

const DEFAULT_COOLDOWNS_MS = Object.freeze({
  RATE_LIMITED: 60_000,
  SERVER_ERROR: 5_000,
  NETWORK_ERROR: 1_000,
  TIMEOUT: 1_000,
  QUOTA_EXCEEDED: 0,
  UNAUTHORIZED: 0,
  UNKNOWN: 1_000,
});

const DEFAULT_FAILURE_THRESHOLD = 3;

const STORAGE_PREFIX = 'akm';

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

function maskKey(key) {
  if (!key || typeof key !== 'string') return '<none>';
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

function createKeyRecord(providerId, value, meta = {}) {
  return {
    providerId,
    value,
    status: KeyStatus.ACTIVE,
    priority: typeof meta.priority === 'number' ? meta.priority : 0,
    weight: typeof meta.weight === 'number' && meta.weight > 0 ? meta.weight : 1,
    stats: {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastUsed: null,
      lastError: null,
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

function keyStorageId(keyValue) {
  return crypto.createHash('md5').update(keyValue).digest('hex').slice(0, 8);
}

class ApiKeyManager {
  /**
   * @param {object} [opts]
   * @param {object} [opts.cooldownsMs]
   * @param {number} [opts.failureThreshold]
   * @param {string} [opts.defaultStrategy]
   * @param {object} [opts.storageProvider] - optional StorageProvider
   */
  constructor(opts = {}) {
    this.keysByProvider = new Map();
    this.cursorsByProvider = new Map();
    this.providerConfig = new Map();
    this.cooldownsMs = { ...DEFAULT_COOLDOWNS_MS, ...(opts.cooldownsMs || {}) };
    this.failureThreshold = opts.failureThreshold !== undefined
      ? opts.failureThreshold
      : DEFAULT_FAILURE_THRESHOLD;
    this.defaultStrategy = opts.defaultStrategy || 'round-robin';
    this._store = opts.storageProvider || null;
    this.loaded = false;
  }

  // ---------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------

  _keyRecordId(providerId, keyValue) {
    return `${STORAGE_PREFIX}:${providerId}:keys:${keyStorageId(keyValue)}`;
  }

  _cursorKey(providerId) {
    return `${STORAGE_PREFIX}:${providerId}:cursor`;
  }

  _configKey(providerId) {
    return `${STORAGE_PREFIX}:${providerId}:config`;
  }

  _allKeysPattern(providerId) {
    return `${STORAGE_PREFIX}:${providerId}:keys:*`;
  }

  /** Persist a single key record to storage (fire-and-forget). */
  _persistRecord(record) {
    if (!this._store) return;
    const sid = this._keyRecordId(record.providerId, record.value);
    this._store.set(sid, {
      providerId: record.providerId,
      value: record.value,
      status: record.status,
      priority: record.priority,
      weight: record.weight,
      stats: { ...record.stats },
      cooldownUntil: record.cooldownUntil,
    }).catch(() => {});
  }

  /** Persist cursor for a provider. */
  _persistCursor(providerId) {
    if (!this._store) return;
    const cursor = this.cursorsByProvider.get(providerId);
    if (!cursor) return;
    this._store.set(this._cursorKey(providerId), cursor).catch(() => {});
  }

  /** Persist provider config. */
  _persistConfig(providerId) {
    if (!this._store) return;
    const cfg = this.providerConfig.get(providerId);
    if (!cfg) return;
    this._store.set(this._configKey(providerId), cfg).catch(() => {});
  }

  /** Delete key record from storage. */
  _deleteRecord(providerId, keyValue) {
    if (!this._store) return;
    this._store.del(this._keyRecordId(providerId, keyValue)).catch(() => {});
  }

  /** Restore key records, cursors, and configs from storage after load(). */
  async _restoreFromStorage() {
    if (!this._store) return;

    for (const [providerId, records] of this.keysByProvider.entries()) {
      // Restore key records
      for (const record of records) {
        try {
          const stored = await this._store.get(this._keyRecordId(providerId, record.value));
          if (stored) {
            if (stored.status) record.status = stored.status;
            if (stored.priority !== undefined) record.priority = stored.priority;
            if (stored.weight !== undefined) record.weight = stored.weight;
            if (stored.stats) Object.assign(record.stats, stored.stats);
            if (stored.cooldownUntil !== undefined) record.cooldownUntil = stored.cooldownUntil;
          }
        } catch (_) { /* ignore storage errors during restore */ }
      }

      // Restore cursor
      try {
        const cursor = await this._store.get(this._cursorKey(providerId));
        if (cursor && typeof cursor.lastIdx === 'number') {
          this.cursorsByProvider.set(providerId, cursor);
        }
      } catch (_) {}

      // Restore config
      try {
        const cfg = await this._store.get(this._configKey(providerId));
        if (cfg) {
          this.providerConfig.set(providerId, cfg);
        }
      } catch (_) {}
    }
  }

  /**
   * Migrate all current in-memory state to storage. Safe to call multiple
   * times — overwrites with latest values. Returns { keys, cursors, configs }
   * counts.
   */
  async migrate() {
    if (!this._store) return { keys: 0, cursors: 0, configs: 0, error: 'no storage provider' };

    const promises = [];
    let keys = 0;
    for (const [providerId, records] of this.keysByProvider.entries()) {
      for (const record of records) {
        promises.push(this._store.set(
          this._keyRecordId(providerId, record.value),
          {
            providerId: record.providerId,
            value: record.value,
            status: record.status,
            priority: record.priority,
            weight: record.weight,
            stats: { ...record.stats },
            cooldownUntil: record.cooldownUntil,
          }
        ));
        keys += 1;
      }
      promises.push(this._store.set(this._cursorKey(providerId), this.cursorsByProvider.get(providerId) || { lastIdx: -1, lastValue: null }));
      promises.push(this._store.set(this._configKey(providerId), this.providerConfig.get(providerId) || {}));
    }

    await Promise.allSettled(promises);

    const cCount = this.cursorsByProvider.size;
    const cfgCount = this.providerConfig.size;

    logger.info('ApiKeyManager: migration complete', { keys, cursors: cCount, configs: cfgCount });
    return { keys, cursors: cCount, configs: cfgCount };
  }

  // ---------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------

  load(providers) {
    if (!Array.isArray(providers)) {
      logger.error('ApiKeyManager.load requires an array of providers');
      return this;
    }

    const next = new Map();
    const nextConfig = new Map();
    for (const p of providers) {
      if (!p || !p.id) continue;

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

    // Async restore from storage (fire-and-forget — non-blocking)
    if (this._store) {
      this._restoreFromStorage().then(() => {
        logger.info('ApiKeyManager: restored persisted state');
      }).catch((err) => {
        logger.warn('ApiKeyManager: restore failed, using fresh state', { error: err.message });
      });
    }

    logger.info('ApiKeyManager initialized', {
      providers: next.size,
      totalKeys: Array.from(next.values()).reduce((sum, arr) => sum + arr.length, 0),
    });

    return this;
  }

  // ---------------------------------------------------------------
  // Strategy & cooldown config
  // ---------------------------------------------------------------

  getStrategy(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && cfg.strategy) || this.defaultStrategy;
  }

  setStrategy(providerId, strategyId) {
    const cfg = this.providerConfig.get(providerId) || {
      strategy: this.defaultStrategy,
      cooldownsMs: null,
      failureThreshold: this.failureThreshold,
    };
    cfg.strategy = strategyId || this.defaultStrategy;
    this.providerConfig.set(providerId, cfg);
    this._persistConfig(providerId);
  }

  _cooldownsFor(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && cfg.cooldownsMs) || this.cooldownsMs;
  }

  _thresholdFor(providerId) {
    const cfg = this.providerConfig.get(providerId);
    return (cfg && typeof cfg.failureThreshold === 'number') ? cfg.failureThreshold : this.failureThreshold;
  }

  // ---------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------

  _records(providerId) {
    return this.keysByProvider.get(providerId) || [];
  }

  _findKeyRecord(providerId, value) {
    return this._records(providerId).find((r) => r.value === value) || null;
  }

  _reconcileCooldown(record) {
    if (record.status === KeyStatus.COOLDOWN && record.cooldownUntil !== null) {
      if (Date.now() >= record.cooldownUntil) {
        record.status = KeyStatus.ACTIVE;
        record.cooldownUntil = null;
        this._persistRecord(record);
        logger.info('API key re-enabled after cooldown', {
          providerId: record.providerId,
          key: maskKey(record.value),
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // Key selection
  // ---------------------------------------------------------------

  getNextKey(providerId) {
    const records = this._records(providerId);

    if (records.length === 0) {
      const err = new Error(`No API keys configured for provider "${providerId}"`);
      err.statusCode = 503;
      err.info = { code: 'NO_API_KEYS', providerId };
      throw err;
    }

    for (const r of records) this._reconcileCooldown(r);

    const candidates = records.filter((r) => r.status === KeyStatus.ACTIVE);

    if (candidates.length === 0) {
      const err = new Error(`All API keys for provider "${providerId}" are unavailable`);
      err.statusCode = 503;
      err.info = { code: 'ALL_KEYS_UNAVAILABLE', providerId };
      throw err;
    }

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
    cursor.lastIdx = idx;
    cursor.lastValue = selected.value;
    this.cursorsByProvider.set(providerId, cursor);
    this._persistCursor(providerId);

    selected.stats.lastUsed = new Date().toISOString();
    selected.stats.totalRequests += 1;
    this._persistRecord(selected);

    return selected.value;
  }

  // ---------------------------------------------------------------
  // Success / Failure reporting
  // ---------------------------------------------------------------

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
    if (record.status === KeyStatus.RATE_LIMITED) {
      record.status = KeyStatus.ACTIVE;
      record.cooldownUntil = null;
    }
    this._persistRecord(record);
  }

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

    if (category === 'UNAUTHORIZED') {
      record.status = KeyStatus.UNAUTHORIZED;
      record.cooldownUntil = null;
      this._persistRecord(record);
      logger.warn('API key marked UNAUTHORIZED', { providerId, key: maskKey(key) });
      return;
    }
    if (category === 'QUOTA_EXCEEDED') {
      record.status = KeyStatus.QUOTA_EXCEEDED;
      record.cooldownUntil = null;
      this._persistRecord(record);
      logger.warn('API key marked QUOTA_EXCEEDED', { providerId, key: maskKey(key) });
      return;
    }

    if (category === 'RATE_LIMITED') {
      record.status = KeyStatus.RATE_LIMITED;
    }

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
      this._persistRecord(record);
      logger.warn('API key placed in cooldown', {
        providerId, key: maskKey(key), cooldownMs, category,
        consecutiveFailures: record.stats.consecutiveFailures,
      });
    } else {
      this._persistRecord(record);
    }
  }

  // ---------------------------------------------------------------
  // Manual enable / disable
  // ---------------------------------------------------------------

  disableKey(providerId, key) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return false;
    record.status = KeyStatus.DISABLED;
    record.cooldownUntil = null;
    this._persistRecord(record);
    return true;
  }

  enableKey(providerId, key) {
    const record = this._findKeyRecord(providerId, key);
    if (!record) return false;
    record.status = KeyStatus.ACTIVE;
    record.cooldownUntil = null;
    this._persistRecord(record);
    return true;
  }

  // ---------------------------------------------------------------
  // Read-only queries (no persistence needed)
  // ---------------------------------------------------------------

  getKeyStatus(providerId) {
    return this._records(providerId).map((r) => this._snapshot(r));
  }

  getAllStatus() {
    const out = {};
    for (const [providerId, records] of this.keysByProvider.entries()) {
      out[providerId] = records.map((r) => this._snapshot(r));
    }
    return out;
  }

  getKeyHealth(providerId) {
    return this._records(providerId).map((r) => this._snapshot(r));
  }

  getAllKeyHealth() {
    const out = {};
    for (const [providerId, records] of this.keysByProvider) {
      out[providerId] = records.map((r) => this._snapshot(r));
    }
    return out;
  }

  /**
   * Return the cursor state for a provider (used in tests/admin).
   * @param {string} providerId
   * @returns {object|null}
   */
  getCursor(providerId) {
    return this.cursorsByProvider.get(providerId) || null;
  }

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
}

module.exports = ApiKeyManager;
module.exports.KeyStatus = KeyStatus;
module.exports.DEFAULT_COOLDOWNS_MS = DEFAULT_COOLDOWNS_MS;
module.exports.DEFAULT_FAILURE_THRESHOLD = DEFAULT_FAILURE_THRESHOLD;
module.exports.errorCodeToCategory = errorCodeToCategory;
module.exports.maskKey = maskKey;
module.exports.createKeyRecord = createKeyRecord;
