/**
 * MetricsCollector
 *
 * Central, non-blocking metrics aggregation for the gateway. Hooks into the
 * RequestExecutor at four points (attempt start, attempt success, attempt
 * failure, request completion) and tracks global + per-provider counters
 * and latency distributions.
 *
 * Tracked metrics (global + per-provider):
 *   - totalRequests
 *   - successfulRequests
 *   - failedRequests
 *   - retryCount
 *   - fallbackCount
 *   - latency samples -> average, p50, p95, p99
 *   - promptTokens
 *   - completionTokens
 *   - totalCost (from usage.cost when present)
 *
 * Snapshot-derived metrics:
 *   - activeApiKeys (read from the ApiKeyManager)
 *   - activeProviders (read from the ProviderManager)
 *
 * All collection is in-memory and synchronous (O(1) per event) so it never
 * blocks request execution. Latency percentiles are computed on demand from
 * a bounded sample buffer (reservoir-style cap to avoid unbounded memory).
 */

const DEFAULT_MAX_LATENCY_SAMPLES = 10000;

/**
 * Compute percentile from a sorted array of values.
 * @param {number[]} sorted - ascending-sorted values
 * @param {number} p - percentile 0-100
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Create a fresh per-provider stats record.
 */
function newStats() {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retryCount: 0,
    fallbackCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
    rateLimitRejections: 0,
    latencies: [],
  };
}

class MetricsCollector {
  /**
   * @param {object} deps
   * @param {object} [deps.providerManager] - for activeProviders count
   * @param {object} [deps.apiKeyManager] - for activeApiKeys count
   * @param {object} [opts]
   * @param {number} [opts.maxLatencySamples=10000] - cap on latency samples
   */
  constructor({ providerManager, apiKeyManager } = {}, opts = {}) {
    this.providerManager = providerManager || null;
    this.apiKeyManager = apiKeyManager || null;
    this.maxLatencySamples = opts.maxLatencySamples || DEFAULT_MAX_LATENCY_SAMPLES;

    this.global = newStats();
    this.providers = new Map(); // providerId -> stats
    this.startedAt = Date.now();
    this.configReloadCount = 0;
    this.configReloadFailures = 0;
  }

  /**
   * Ensure a per-provider stats record exists.
   * @param {string} providerId
   * @returns {object}
   * @private
   */
  _provider(providerId) {
    if (!this.providers.has(providerId)) {
      this.providers.set(providerId, newStats());
    }
    return this.providers.get(providerId);
  }

  /**
   * Record a latency sample (bounded buffer — drops oldest when full).
   * @param {object} stats - per-provider or global stats
   * @param {number} latencyMs
   * @private
   */
  _recordLatency(stats, latencyMs) {
    stats.latencies.push(latencyMs);
    if (stats.latencies.length > this.maxLatencySamples) {
      stats.latencies.shift();
    }
  }

  /**
   * Record a request attempt start. Called by the executor at the very
   * beginning of execute()/executeStream().
   *
   * @param {object} detail
   * @param {string} detail.providerId
   */
  recordRequestStart({ providerId }) {
    if (!providerId) return;
    this.global.totalRequests += 1;
    this._provider(providerId).totalRequests += 1;
  }

  /**
   * Record a successful provider attempt. Called by the executor after a
   * provider response is successfully normalized.
   *
   * @param {object} detail
   * @param {string} detail.providerId
   * @param {number} detail.latencyMs - per-attempt latency
   * @param {number} [detail.retryCount]
   * @param {number} [detail.fallbackCount]
   * @param {number} [detail.promptTokens]
   * @param {number} [detail.completionTokens]
   * @param {number} [detail.cost]
   */
  recordSuccess(detail = {}) {
    const { providerId, latencyMs, retryCount, fallbackCount, promptTokens, completionTokens, cost } = detail;
    if (!providerId) return;

    const p = this._provider(providerId);
    p.successfulRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(p, latencyMs);
    if (typeof retryCount === 'number') p.retryCount += retryCount;
    if (typeof fallbackCount === 'number') p.fallbackCount += fallbackCount;
    if (typeof promptTokens === 'number') p.promptTokens += promptTokens;
    if (typeof completionTokens === 'number') p.completionTokens += completionTokens;
    if (typeof cost === 'number') p.totalCost += cost;

    // Global mirrors the provider (not a sum, since the request succeeds on
    // exactly one provider).
    this.global.successfulRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(this.global, latencyMs);
    if (typeof retryCount === 'number') this.global.retryCount += retryCount;
    if (typeof fallbackCount === 'number') this.global.fallbackCount += fallbackCount;
    if (typeof promptTokens === 'number') this.global.promptTokens += promptTokens;
    if (typeof completionTokens === 'number') this.global.completionTokens += completionTokens;
    if (typeof cost === 'number') this.global.totalCost += cost;
  }

  /**
   * Record a failed provider attempt. Called by the executor in the catch
   * block of a provider request.
   *
   * @param {object} detail
   * @param {string} detail.providerId
   * @param {string} [detail.errorCode]
   * @param {number} [detail.latencyMs]
   */
  recordFailure(detail = {}) {
    const { providerId, latencyMs } = detail;
    if (!providerId) return;

    const p = this._provider(providerId);
    p.failedRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(p, latencyMs);
  }

  /**
   * Record a fallback event (the executor moved from one provider to the
   * next).
   *
   * @param {object} detail
   * @param {string} detail.fromProviderId
   * @param {string} detail.toProviderId
   */
  recordFallback(detail = {}) {
    const { fromProviderId } = detail;
    if (fromProviderId) {
      this._provider(fromProviderId).fallbackCount += 1;
    }
  }

  /**
   * Record that a request failed entirely (all providers exhausted).
   *
   * @param {object} detail
   * @param {string} [detail.providerId] - last provider that was tried
   */
  recordRequestFailure(detail = {}) {
    this.global.failedRequests += 1;
    if (detail.providerId) {
      // Already counted the per-provider failure in recordFailure; just
      // bump the global.
    }
  }

  /**
   * Record a rate-limit rejection. Called by the rate-limit middleware
   * when a request is denied (429). Increments the per-key and global
   * rejection counters. When a providerId is given (e.g. for per-provider
   * throttling by the executor), the per-provider counter is also bumped.
   *
   * @param {object} detail
   * @param {string} [detail.scope]
   * @param {string} [detail.apiKeyId]
   * @param {string} [detail.providerId]
   * @param {string} [detail.model]
   */
  recordRateLimitRejection(detail = {}) {
    this.global.rateLimitRejections += 1;
    if (detail.providerId) {
      this._provider(detail.providerId).rateLimitRejections += 1;
    }
  }

  /**
   * Record a successful configuration reload.
   */
  recordConfigReload() {
    this.configReloadCount += 1;
  }

  /**
   * Record a failed configuration reload.
   */
  recordConfigReloadFailure() {
    this.configReloadFailures += 1;
  }

  /**
   * Compute a snapshot of the metrics for a single stats record.
   * @param {object} stats
   * @returns {object}
   * @private
   */
  _snapshot(stats) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    return {
      totalRequests: stats.totalRequests,
      successfulRequests: stats.successfulRequests,
      failedRequests: stats.failedRequests,
      retryCount: stats.retryCount,
      fallbackCount: stats.fallbackCount,
      averageLatencyMs: sorted.length > 0 ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0,
      p50LatencyMs: Math.round(percentile(sorted, 50)),
      p95LatencyMs: Math.round(percentile(sorted, 95)),
      p99LatencyMs: Math.round(percentile(sorted, 99)),
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.promptTokens + stats.completionTokens,
      totalCost: stats.totalCost,
      rateLimitRejections: stats.rateLimitRejections,
      sampleCount: sorted.length,
    };
  }

  /**
   * Return a full metrics snapshot (global + per-provider + derived counts).
   * @returns {object}
   */
  getSnapshot() {
    const providerSnapshots = {};
    for (const [id, stats] of this.providers) {
      providerSnapshots[id] = this._snapshot(stats);
    }

    let activeApiKeys = 0;
    if (this.apiKeyManager && typeof this.apiKeyManager.getAllStatus === 'function') {
      const all = this.apiKeyManager.getAllStatus();
      for (const providerId of Object.keys(all)) {
        for (const key of all[providerId]) {
          if (key.status === 'ACTIVE') activeApiKeys += 1;
        }
      }
    }

    let activeProviders = 0;
    let disabledProviders = 0;
    if (this.providerManager && typeof this.providerManager.getEnabledProviders === 'function') {
      activeProviders = this.providerManager.getEnabledProviders().length;
      if (typeof this.providerManager.listProviders === 'function') {
        disabledProviders = this.providerManager.listProviders().length - activeProviders;
      }
    }

    return {
      uptimeMs: Date.now() - this.startedAt,
      global: this._snapshot(this.global),
      providers: providerSnapshots,
      activeApiKeys,
      activeProviders,
      disabledProviders,
      configReloadCount: this.configReloadCount,
      configReloadFailures: this.configReloadFailures,
    };
  }

  /**
   * Return a lightweight stats summary (no latency histograms).
   * @returns {object}
   */
  getStats() {
    const snap = this.getSnapshot();
    return {
      uptimeMs: snap.uptimeMs,
      global: {
        totalRequests: snap.global.totalRequests,
        successfulRequests: snap.global.successfulRequests,
        failedRequests: snap.global.failedRequests,
        retryCount: snap.global.retryCount,
        fallbackCount: snap.global.fallbackCount,
        averageLatencyMs: snap.global.averageLatencyMs,
        p50LatencyMs: snap.global.p50LatencyMs,
        p95LatencyMs: snap.global.p95LatencyMs,
        p99LatencyMs: snap.global.p99LatencyMs,
        promptTokens: snap.global.promptTokens,
        completionTokens: snap.global.completionTokens,
        totalTokens: snap.global.totalTokens,
        totalCost: snap.global.totalCost,
      },
      providers: Object.fromEntries(
        Object.entries(snap.providers).map(([id, p]) => [id, {
          totalRequests: p.totalRequests,
          successfulRequests: p.successfulRequests,
          failedRequests: p.failedRequests,
          retryCount: p.retryCount,
          fallbackCount: p.fallbackCount,
          averageLatencyMs: p.averageLatencyMs,
          successRate: p.totalRequests > 0 ? Math.round((p.successfulRequests / p.totalRequests) * 10000) / 100 : 100,
        }])
      ),
      activeApiKeys: snap.activeApiKeys,
      activeProviders: snap.activeProviders,
    };
  }

  /**
   * Reset all metrics.
   */
  reset() {
    this.global = newStats();
    this.providers.clear();
    this.startedAt = Date.now();
  }
}

module.exports = MetricsCollector;
module.exports.percentile = percentile;
