const logger = require('../utils/logger');

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half-open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30000;
const DEFAULT_HALF_OPEN_MAX_PROBES = 1;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60000;

/**
 * Create a fresh per-provider health record.
 */
function newHealth() {
  return {
    state: STATE_CLOSED,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccess: null,
    lastFailure: null,
    averageLatencyMs: 0,
    latencyCount: 0,
    latencySum: 0,
    totalSuccess: 0,
    totalFailure: 0,
    openedAt: null,
    halfOpenProbes: 0,
  };
}

/**
 * ProviderHealthMonitor
 *
 * Tracks per-provider health with a circuit-breaker state machine.
 *
 * When a storageProvider is given, health records are persisted through it
 * so state survives restarts. Without storageProvider, everything is
 * in-memory (pure backward compat).
 */
class ProviderHealthMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5]
   * @param {number} [opts.resetTimeoutMs=30000]
   * @param {number} [opts.halfOpenMaxProbes=1]
   * @param {number} [opts.healthCheckIntervalMs=60000]
   * @param {object} [opts.providerManager]
   * @param {object} [opts.httpClient]
   * @param {object} [opts.storageProvider] - optional StorageProvider instance
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold || DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = opts.resetTimeoutMs || DEFAULT_RESET_TIMEOUT_MS;
    this.halfOpenMaxProbes = opts.halfOpenMaxProbes || DEFAULT_HALF_OPEN_MAX_PROBES;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs || DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.providerManager = opts.providerManager || null;
    this.httpClient = opts.httpClient || null;
    this._store = opts.storageProvider || null;

    this.health = new Map();
    this._timer = null;
  }

  /**
   * Ensure a health record exists for a provider.
   */
  _ensure(providerId) {
    if (!this.health.has(providerId)) {
      this.health.set(providerId, newHealth());
    }
    return this.health.get(providerId);
  }

  /**
   * Persist the health record for a provider to storage (fire-and-forget).
   */
  _persist(providerId) {
    if (!this._store) return;
    const h = this.health.get(providerId);
    if (!h) return;
    this._store.hset(`health:${providerId}`, {
      state: h.state,
      consecutiveFailures: h.consecutiveFailures,
      consecutiveSuccesses: h.consecutiveSuccesses,
      lastSuccess: h.lastSuccess,
      lastFailure: h.lastFailure,
      averageLatencyMs: h.averageLatencyMs,
      latencyCount: h.latencyCount,
      latencySum: h.latencySum,
      totalSuccess: h.totalSuccess,
      totalFailure: h.totalFailure,
      openedAt: h.openedAt,
      halfOpenProbes: h.halfOpenProbes,
    }).catch(() => {});
  }

  /**
   * Record a successful request against a provider.
   */
  recordSuccess(detail = {}) {
    const { providerId, latencyMs } = detail;
    if (!providerId) return;
    const h = this._ensure(providerId);

    h.consecutiveFailures = 0;
    h.consecutiveSuccesses += 1;
    h.totalSuccess += 1;
    h.lastSuccess = Date.now();

    if (typeof latencyMs === 'number') {
      h.latencySum += latencyMs;
      h.latencyCount += 1;
      h.averageLatencyMs = Math.round(h.latencySum / h.latencyCount);
    }

    if (h.state === STATE_HALF_OPEN) {
      h.state = STATE_CLOSED;
      h.openedAt = null;
      h.halfOpenProbes = 0;
      logger.info('Provider circuit closed (recovered)', { providerId });
    }

    this._persist(providerId);
  }

  /**
   * Record a failed request against a provider.
   */
  recordFailure(detail = {}) {
    const { providerId } = detail;
    if (!providerId) return;
    const h = this._ensure(providerId);

    h.consecutiveFailures += 1;
    h.consecutiveSuccesses = 0;
    h.totalFailure += 1;
    h.lastFailure = Date.now();

    if (h.state === STATE_HALF_OPEN) {
      h.state = STATE_OPEN;
      h.openedAt = Date.now();
      h.halfOpenProbes = 0;
      logger.warn('Provider circuit re-opened (half-open probe failed)', { providerId });
    } else if (h.state === STATE_CLOSED && h.consecutiveFailures >= this.failureThreshold) {
      h.state = STATE_OPEN;
      h.openedAt = Date.now();
      logger.warn('Provider circuit opened', {
        providerId,
        consecutiveFailures: h.consecutiveFailures,
        threshold: this.failureThreshold,
      });
    }

    this._persist(providerId);
  }

  /**
   * Whether a provider is currently available to serve requests.
   */
  isAvailable(providerId) {
    if (!providerId) return true;
    const h = this._ensure(providerId);

    if (h.state === STATE_CLOSED) return true;

    if (h.state === STATE_OPEN) {
      if (h.openedAt && (Date.now() - h.openedAt) >= this.resetTimeoutMs) {
        h.state = STATE_HALF_OPEN;
        h.halfOpenProbes = 0;
        logger.info('Provider circuit half-open (probe allowed)', { providerId });
        this._persist(providerId);
        return true;
      }
      return false;
    }

    if (h.state === STATE_HALF_OPEN) {
      if (h.halfOpenProbes < this.halfOpenMaxProbes) {
        h.halfOpenProbes += 1;
        this._persist(providerId);
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Return the health snapshot for a single provider.
   */
  getHealth(providerId) {
    const h = this.health.get(providerId);
    if (!h) return null;
    return this._snapshot(providerId, h);
  }

  /**
   * Return health snapshots for all tracked providers.
   */
  getAllHealth() {
    const out = {};
    for (const [id, h] of this.health) {
      out[id] = this._snapshot(id, h);
    }
    return out;
  }

  /**
   * Project a health record into a serializable snapshot.
   */
  _snapshot(providerId, h) {
    const total = h.totalSuccess + h.totalFailure;
    return {
      providerId,
      online: h.state !== STATE_OPEN,
      circuitState: h.state,
      consecutiveFailures: h.consecutiveFailures,
      consecutiveSuccesses: h.consecutiveSuccesses,
      lastSuccess: h.lastSuccess ? new Date(h.lastSuccess).toISOString() : null,
      lastFailure: h.lastFailure ? new Date(h.lastFailure).toISOString() : null,
      averageLatencyMs: h.averageLatencyMs,
      successRate: total > 0 ? Math.round((h.totalSuccess / total) * 10000) / 100 : 100,
      totalSuccess: h.totalSuccess,
      totalFailure: h.totalFailure,
    };
  }

  /**
   * Start the periodic health-check timer.
   */
  startHealthChecks() {
    this.stopHealthChecks();
    if (!this.httpClient || !this.providerManager) return;

    const check = async () => {
      const providers = this.providerManager.getEnabledProviders();
      for (const provider of providers) {
        const h = this.health.get(provider.id);
        if (h && h.state === STATE_CLOSED && h.consecutiveFailures === 0) continue;

        try {
          await this.httpClient.sendRequest(provider, '/models', { method: 'GET', timeout: 5000 });
          this.recordSuccess({ providerId: provider.id });
        } catch (err) {
          this.recordFailure({ providerId: provider.id, errorCode: err.info && err.info.code });
        }
      }
    };

    this._timer = setInterval(check, this.healthCheckIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Stop the periodic health-check timer.
   */
  stopHealthChecks() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Reset all health state.
   */
  reset() {
    this.health.clear();
    if (this._store) {
      // Best-effort clear
      this._store.keys('health:*').then((keys) => {
        for (const k of keys) this._store.del(k).catch(() => {});
      }).catch(() => {});
    }
  }
}

module.exports = ProviderHealthMonitor;
module.exports.STATE_CLOSED = STATE_CLOSED;
module.exports.STATE_OPEN = STATE_OPEN;
module.exports.STATE_HALF_OPEN = STATE_HALF_OPEN;
