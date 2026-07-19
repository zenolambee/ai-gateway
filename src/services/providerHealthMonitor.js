const logger = require('../utils/logger');

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half-open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30000; // 30s before half-open probe
const DEFAULT_HALF_OPEN_MAX_PROBES = 1;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60000; // 60s

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
 * Tracks per-provider health with a circuit-breaker state machine:
 *
 *   closed    -> all requests allowed; failures increment consecutiveFailures
 *   open      -> requests blocked; after resetTimeout, transition to half-open
 *   half-open -> a limited number of probe requests are allowed; on success
 *                the circuit closes, on failure it re-opens
 *
 * The monitor is driven by the RequestExecutor (recordSuccess /
 * recordFailure) and optionally by a periodic health check timer.
 * Providers that recover automatically become available again.
 *
 * The executor calls `isAvailable(providerId)` before using a provider; when
 * the circuit is open, the provider is skipped (treated like a fallback).
 *
 * NO HTTP, NO retry — pure state machine.
 */
class ProviderHealthMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5] - consecutive failures to open
   * @param {number} [opts.resetTimeoutMs=30000] - time before half-open
   * @param {number} [opts.halfOpenMaxProbes=1] - probes allowed in half-open
   * @param {number} [opts.healthCheckIntervalMs=60000] - periodic check
   * @param {object} [opts.providerManager] - for listing providers to check
   * @param {object} [opts.httpClient] - for health-check probes
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold || DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = opts.resetTimeoutMs || DEFAULT_RESET_TIMEOUT_MS;
    this.halfOpenMaxProbes = opts.halfOpenMaxProbes || DEFAULT_HALF_OPEN_MAX_PROBES;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs || DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.providerManager = opts.providerManager || null;
    this.httpClient = opts.httpClient || null;

    this.health = new Map(); // providerId -> health record
    this._timer = null;
  }

  /**
   * Ensure a health record exists for a provider.
   * @param {string} providerId
   * @returns {object}
   * @private
   */
  _ensure(providerId) {
    if (!this.health.has(providerId)) {
      this.health.set(providerId, newHealth());
    }
    return this.health.get(providerId);
  }

  /**
   * Record a successful request against a provider. In half-open state, a
   * success closes the circuit. Resets consecutive failures.
   *
   * @param {object} detail
   * @param {string} detail.providerId
   * @param {number} [detail.latencyMs]
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
  }

  /**
   * Record a failed request against a provider. Increments consecutive
   * failures and opens the circuit when the threshold is reached.
   *
   * @param {object} detail
   * @param {string} detail.providerId
   * @param {string} [detail.errorCode]
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
      // A failure during half-open re-opens the circuit.
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
  }

  /**
   * Whether a provider is currently available to serve requests. When the
   * circuit is open, the provider is skipped (unless the reset timeout has
   * elapsed, in which case it transitions to half-open and allows a probe).
   *
   * @param {string} providerId
   * @returns {boolean}
   */
  isAvailable(providerId) {
    if (!providerId) return true;
    const h = this._ensure(providerId);

    if (h.state === STATE_CLOSED) return true;

    if (h.state === STATE_OPEN) {
      // Check if enough time has elapsed to try a half-open probe.
      if (h.openedAt && (Date.now() - h.openedAt) >= this.resetTimeoutMs) {
        h.state = STATE_HALF_OPEN;
        h.halfOpenProbes = 0;
        logger.info('Provider circuit half-open (probe allowed)', { providerId });
        return true;
      }
      return false;
    }

    if (h.state === STATE_HALF_OPEN) {
      // Allow a limited number of probes.
      if (h.halfOpenProbes < this.halfOpenMaxProbes) {
        h.halfOpenProbes += 1;
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Return the health snapshot for a single provider.
   * @param {string} providerId
   * @returns {object|null}
   */
  getHealth(providerId) {
    const h = this.health.get(providerId);
    if (!h) return null;
    return this._snapshot(providerId, h);
  }

  /**
   * Return health snapshots for all tracked providers.
   * @returns {object} map of providerId -> health snapshot
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
   * @param {string} providerId
   * @param {object} h
   * @returns {object}
   * @private
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
   * Start the periodic health-check timer. For each enabled provider, the
   * monitor issues a lightweight probe (a GET to the provider's base URL).
   * A successful probe records a success (recovering an open circuit); a
   * failed probe records a failure.
   *
   * The timer is skipped when no httpClient or providerManager is attached.
   */
  startHealthChecks() {
    this.stopHealthChecks();
    if (!this.httpClient || !this.providerManager) return;

    const check = async () => {
      const providers = this.providerManager.getEnabledProviders();
      for (const provider of providers) {
        // Don't probe providers whose circuit is closed and healthy.
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
  }
}

module.exports = ProviderHealthMonitor;
module.exports.STATE_CLOSED = STATE_CLOSED;
module.exports.STATE_OPEN = STATE_OPEN;
module.exports.STATE_HALF_OPEN = STATE_HALF_OPEN;
