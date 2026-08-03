const logger = require('../utils/logger');

const DEFAULT_INTERVAL_MS = 30000;
const MAX_HISTORY = 60;

/**
 * SDKHealthService
 *
 * Periodically calls healthCheck() on every registered SDK adapter (via the
 * SDKRoutingBridge) and records latency/success/error/uptime/lastCheck/
 * lastFailure. Results are exposed for the dashboard, which auto-updates
 * without a restart.
 *
 * Also builds a capability map (from SDK manifests + legacy discovery) and
 * publishes it to the ModelRouter so capability-aware routing works across
 * both SDK and legacy providers.
 */
class SDKHealthService {
  /**
   * @param {object} deps
   * @param {object} deps.sdkRoutingBridge
   * @param {object} deps.providerManager
   * @param {object} deps.modelRouter
   * @param {object} [deps.legacyDiscovery] - for legacy capability detection
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=30000]
   */
  constructor({ sdkRoutingBridge, providerManager, modelRouter, legacyDiscovery }, opts = {}) {
    this.bridge = sdkRoutingBridge || null;
    this.providerManager = providerManager;
    this.modelRouter = modelRouter || null;
    this.legacyDiscovery = legacyDiscovery || null;
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this._health = new Map(); // providerId -> { lastCheck, lastFailure, successCount, failureCount, latencies, uptimeMs, lastLatencyMs, healthy }
    this._timer = null;
    this._running = false;
  }

  /** Get the live health summary for all providers. */
  getStatus() {
    const out = {};
    for (const [id, h] of this._health) {
      out[id] = this._snapshot(id, h);
    }
    return out;
  }

  _snapshot(providerId, h) {
    const total = h.successCount + h.failureCount;
    return {
      providerId,
      healthy: h.healthy,
      lastCheck: h.lastCheck,
      lastFailure: h.lastFailure,
      lastLatencyMs: h.lastLatencyMs,
      averageLatencyMs: h.latencies.length > 0
        ? Math.round(h.latencies.reduce((s, v) => s + v, 0) / h.latencies.length)
        : 0,
      successRate: total > 0 ? Math.round((h.successCount / total) * 10000) / 100 : 100,
      errorRate: total > 0 ? Math.round((h.failureCount / total) * 10000) / 100 : 0,
      totalChecks: total,
      uptimeMs: h.startedAt ? Date.now() - h.startedAt : 0,
      successCount: h.successCount,
      failureCount: h.failureCount,
    };
  }

  /**
   * Run one health check cycle against all enabled providers that have an SDK
   * adapter. Records results; then publishes capability map to the router.
   * @returns {Promise<object>} health status
   */
  async checkNow() {
    const providers = this.providerManager.getEnabledProviders();
    await Promise.all(providers.map(async (provider) => {
      // Only SDK-routed providers are health-checked via healthCheck().
      if (!this.bridge || !this.bridge.hasSDK(provider)) return;
      const adapter = this.bridge.getSDKAdapter(provider);
      if (!adapter || typeof adapter.healthCheck !== 'function') return;

      let h = this._health.get(provider.id);
      if (!h) {
        h = { successCount: 0, failureCount: 0, latencies: [], healthy: false, lastCheck: null, lastFailure: null, lastLatencyMs: null, startedAt: Date.now() };
        this._health.set(provider.id, h);
      }

      try {
        const res = await adapter.healthCheck({ timeout: 5000 });
        h.lastCheck = Date.now();
        h.lastLatencyMs = res.latencyMs || 0;
        h.latencies.push(h.lastLatencyMs);
        if (h.latencies.length > MAX_HISTORY) h.latencies.shift();
        if (res.healthy) {
          h.successCount += 1;
          h.healthy = true;
        } else {
          h.failureCount += 1;
          h.healthy = false;
          h.lastFailure = Date.now();
        }
      } catch (err) {
        h.failureCount += 1;
        h.healthy = false;
        h.lastCheck = Date.now();
        h.lastFailure = Date.now();
        logger.warn('SDKHealthService: healthCheck threw', { providerId: provider.id, error: err.message });
      }
    }));

    this._publishCapabilities();
    return this.getStatus();
  }

  /**
   * Publish a capability map to the ModelRouter for capability-aware routing.
   * SDK providers use their manifest capabilities; legacy providers use the
   * existing ProviderDiscovery.detectCapabilities heuristic per model (best
   * effort — a single provider-level capability map is published).
   * @private
   */
  _publishCapabilities() {
    if (!this.modelRouter) return;
    const map = {};
    for (const p of this.providerManager.getEnabledProviders()) {
      if (this.bridge && this.bridge.hasSDK(p)) {
        const c = this.bridge.capabilities(p);
        if (c) map[p.id] = c;
      } else if (this.legacyDiscovery) {
        // Legacy: build a provider-level capability union from its models.
        try {
          const models = Array.isArray(p.supportedModels) ? p.supportedModels : [];
          if (models.length === 0) continue;
          // Use the first model's detected caps as a representative (approximation
          // for legacy providers whose capabilities are per-model heuristics).
          const caps = this.legacyDiscovery.detectCapabilities(models[0]);
          if (caps) {
            map[p.id] = {
              chat: caps.chat, responses: caps.responses, embeddings: caps.embeddings,
              images: caps.images, audio: caps.audio, tools: caps.tools,
              vision: caps.vision, streaming: caps.streaming,
            };
          }
        } catch (_) { /* skip */ }
      }
    }
    this.modelRouter.setCapabilityMap(map);
  }

  /** Start periodic health checks. */
  start() {
    if (this._running) return;
    this._running = true;
    this.checkNow().catch(() => {});
    this._timer = setInterval(() => {
      if (this._running) this.checkNow().catch(() => {});
    }, this.intervalMs);
    if (this._timer && this._timer.unref) this._timer.unref();
    logger.info('SDKHealthService: started', { intervalMs: this.intervalMs });
  }

  /** Stop periodic health checks. */
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = SDKHealthService;
