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
 * When a storageProvider is given, counters are persisted through it
 * (Redis or MemoryStorage). Latency samples are always kept in-memory
 * (ephemeral). Without storageProvider, everything is in-memory
 * (pure backward compat).
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

/**
 * Create a fresh per-virtual-model stats record.
 */
function newVirtualModelStats() {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    fallbackCount: 0,
    latencies: [],
    providerSelections: {},
  };
}

class MetricsCollector {
  /**
   * @param {object} deps
   * @param {object} [deps.providerManager] - for activeProviders count
   * @param {object} [deps.apiKeyManager] - for activeApiKeys count
   * @param {object} [deps.storageProvider] - optional StorageProvider instance
   * @param {object} [opts]
   * @param {number} [opts.maxLatencySamples=10000]
   */
  constructor({ providerManager, apiKeyManager, storageProvider } = {}, opts = {}) {
    this.providerManager = providerManager || null;
    this.apiKeyManager = apiKeyManager || null;
    this.maxLatencySamples = opts.maxLatencySamples || DEFAULT_MAX_LATENCY_SAMPLES;
    this._store = storageProvider || null;

    this.global = newStats();
    this.providers = new Map();
    this.virtualModels = new Map();
    this.startedAt = Date.now();
    this.configReloadCount = 0;
    this.configReloadFailures = 0;
  }

  /**
   * Persist a global counter to storage (fire-and-forget).
   * @param {string} field
   * @param {number} value
   * @private
   */
  _persistGlobal(field, value) {
    if (this._store) {
      this._store.hset('metrics:global', { [field]: value }).catch(() => {});
    }
  }

  /**
   * Persist a per-provider counter to storage (fire-and-forget).
   * @param {string} providerId
   * @param {string} field
   * @param {number} value
   * @private
   */
  _persistProvider(providerId, field, value) {
    if (this._store) {
      this._store.hset(`metrics:providers:${providerId}`, { [field]: value }).catch(() => {});
    }
  }

  /**
   * Persist a per-virtual-model counter to storage (fire-and-forget).
   * @param {string} vmId
   * @param {string} field
   * @param {*} value
   * @private
   */
  _persistVM(vmId, field, value) {
    if (this._store) {
      this._store.hset(`metrics:vm:${vmId}`, { [field]: value }).catch(() => {});
    }
  }

  /**
   * Ensure a per-virtual-model stats record exists.
   * @param {string} virtualModelId
   * @returns {object}
   * @private
   */
  _virtualModel(virtualModelId) {
    if (!this.virtualModels.has(virtualModelId)) {
      this.virtualModels.set(virtualModelId, newVirtualModelStats());
    }
    return this.virtualModels.get(virtualModelId);
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
   * @param {object} stats
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
   * Record a request attempt start.
   */
  recordRequestStart({ providerId, virtualModelId }) {
    if (!providerId) return;
    this.global.totalRequests += 1;
    this._persistGlobal('totalRequests', this.global.totalRequests);

    const p = this._provider(providerId);
    p.totalRequests += 1;
    this._persistProvider(providerId, 'totalRequests', p.totalRequests);

    if (virtualModelId) {
      const vm = this._virtualModel(virtualModelId);
      vm.totalRequests += 1;
      vm.providerSelections[providerId] = vm.providerSelections[providerId] || { selected: 0, success: 0, failure: 0 };
      vm.providerSelections[providerId].selected += 1;
      this._persistVM(virtualModelId, 'totalRequests', vm.totalRequests);
    }
  }

  /**
   * Record a successful provider attempt.
   */
  recordSuccess(detail = {}) {
    const { providerId, latencyMs, retryCount, fallbackCount, promptTokens, completionTokens, cost, virtualModelId } = detail;
    if (!providerId) return;

    const p = this._provider(providerId);
    p.successfulRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(p, latencyMs);
    if (typeof retryCount === 'number') p.retryCount += retryCount;
    if (typeof fallbackCount === 'number') p.fallbackCount += fallbackCount;
    if (typeof promptTokens === 'number') p.promptTokens += promptTokens;
    if (typeof completionTokens === 'number') p.completionTokens += completionTokens;
    if (typeof cost === 'number') p.totalCost += cost;

    this.global.successfulRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(this.global, latencyMs);
    if (typeof retryCount === 'number') this.global.retryCount += retryCount;
    if (typeof fallbackCount === 'number') this.global.fallbackCount += fallbackCount;
    if (typeof promptTokens === 'number') this.global.promptTokens += promptTokens;
    if (typeof completionTokens === 'number') this.global.completionTokens += completionTokens;
    if (typeof cost === 'number') this.global.totalCost += cost;

    if (this._store) {
      this._store.hset('metrics:global', {
        successfulRequests: this.global.successfulRequests,
        retryCount: this.global.retryCount,
        fallbackCount: this.global.fallbackCount,
        promptTokens: this.global.promptTokens,
        completionTokens: this.global.completionTokens,
        totalCost: this.global.totalCost,
      }).catch(() => {});
      this._persistProvider(providerId, 'successfulRequests', p.successfulRequests);
    }

    if (virtualModelId) {
      const vm = this._virtualModel(virtualModelId);
      vm.successfulRequests += 1;
      if (typeof latencyMs === 'number') this._recordLatency(vm, latencyMs);
      if (typeof fallbackCount === 'number') vm.fallbackCount += fallbackCount;
      const sel = vm.providerSelections[providerId] || (vm.providerSelections[providerId] = { selected: 0, success: 0, failure: 0 });
      sel.success += 1;
      if (this._store) {
        this._persistVM(virtualModelId, 'successfulRequests', vm.successfulRequests);
      }
    }
  }

  /**
   * Record a failed provider attempt.
   */
  recordFailure(detail = {}) {
    const { providerId, latencyMs, virtualModelId } = detail;
    if (!providerId) return;

    const p = this._provider(providerId);
    p.failedRequests += 1;
    if (typeof latencyMs === 'number') this._recordLatency(p, latencyMs);
    this._persistProvider(providerId, 'failedRequests', p.failedRequests);

    if (virtualModelId) {
      const vm = this._virtualModel(virtualModelId);
      vm.failedRequests += 1;
      const sel = vm.providerSelections[providerId] || (vm.providerSelections[providerId] = { selected: 0, success: 0, failure: 0 });
      sel.failure += 1;
      if (this._store) {
        this._persistVM(virtualModelId, 'failedRequests', vm.failedRequests);
      }
    }
  }

  /**
   * Record a fallback event.
   */
  recordFallback(detail = {}) {
    const { fromProviderId, virtualModelId } = detail;
    if (fromProviderId) {
      this._provider(fromProviderId).fallbackCount += 1;
    }
    if (virtualModelId) {
      this._virtualModel(virtualModelId).fallbackCount += 1;
    }
  }

  /**
   * Record that a request failed entirely (all providers exhausted).
   */
  recordRequestFailure(detail = {}) {
    this.global.failedRequests += 1;
    this._persistGlobal('failedRequests', this.global.failedRequests);
  }

  /**
   * Record a rate-limit rejection.
   */
  recordRateLimitRejection(detail = {}) {
    this.global.rateLimitRejections += 1;
    this._persistGlobal('rateLimitRejections', this.global.rateLimitRejections);
    if (detail.providerId) {
      this._provider(detail.providerId).rateLimitRejections += 1;
      this._persistProvider(detail.providerId, 'rateLimitRejections', this._provider(detail.providerId).rateLimitRejections);
    }
  }

  recordConfigReload() { this.configReloadCount += 1; }
  recordConfigReloadFailure() { this.configReloadFailures += 1; }

  /**
   * Compute a snapshot of the metrics for a single stats record.
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
   * Return a full metrics snapshot.
   */
  getSnapshot() {
    const providerSnapshots = {};
    for (const [id, stats] of this.providers) {
      providerSnapshots[id] = this._snapshot(stats);
    }

    const virtualModelSnapshots = {};
    for (const [id, stats] of this.virtualModels) {
      virtualModelSnapshots[id] = this._virtualModelSnapshot(id, stats);
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
      virtualModels: virtualModelSnapshots,
      activeApiKeys,
      activeProviders,
      disabledProviders,
      configReloadCount: this.configReloadCount,
      configReloadFailures: this.configReloadFailures,
    };
  }

  /**
   * Compute a snapshot of per-virtual-model stats.
   */
  _virtualModelSnapshot(id, stats) {
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    const total = stats.successfulRequests + stats.failedRequests;
    return {
      virtualModelId: id,
      totalRequests: stats.totalRequests,
      successfulRequests: stats.successfulRequests,
      failedRequests: stats.failedRequests,
      fallbackCount: stats.fallbackCount,
      successRate: total > 0 ? Math.round((stats.successfulRequests / total) * 10000) / 100 : 100,
      averageLatencyMs: sorted.length > 0 ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : 0,
      p50LatencyMs: Math.round(percentile(sorted, 50)),
      p95LatencyMs: Math.round(percentile(sorted, 95)),
      p99LatencyMs: Math.round(percentile(sorted, 99)),
      sampleCount: sorted.length,
      providerSelections: stats.providerSelections,
    };
  }

  /**
   * Return a lightweight stats summary.
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
    this.virtualModels.clear();
    this.startedAt = Date.now();
    if (this._store) {
      this._store.flush().catch(() => {});
    }
  }
}

module.exports = MetricsCollector;
module.exports.percentile = percentile;
