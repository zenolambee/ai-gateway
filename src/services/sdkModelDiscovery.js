const logger = require('../utils/logger');

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min default

/**
 * SDKModelDiscovery
 *
 * Dynamic model discovery that prefers the ProviderAdapterSDK's fetchModels()
 * when a provider has a registered SDK adapter, and falls back to the legacy
 * ProviderDiscovery (GET /models via the legacy adapter) otherwise.
 *
 * Features:
 *   - cache TTL per provider (discovery results cached, reused within TTL)
 *   - hot reload: merges discovered models into the provider config and
 *     invalidates the ModelRegistry so /v1/models and the dashboard update
 *   - manual refresh via `discover(force)` / admin API
 *   - fallback to manifest supportedModels when the endpoint fails
 *   - non-blocking, never crashes the gateway
 */
class SDKModelDiscovery {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager
   * @param {object} deps.sdkRoutingBridge
   * @param {object} [deps.legacyDiscovery] - existing ProviderDiscovery for fallback
   * @param {object} [deps.modelRegistry]
   * @param {object} [deps.providerSDKRegistry]
   * @param {object} [opts]
   * @param {number} [opts.cacheTtlMs=300000]
   */
  constructor({ providerManager, sdkRoutingBridge, legacyDiscovery, modelRegistry, providerSDKRegistry }, opts = {}) {
    this.providerManager = providerManager;
    this.bridge = sdkRoutingBridge || null;
    this.legacyDiscovery = legacyDiscovery || null;
    this.modelRegistry = modelRegistry || null;
    this.sdkRegistry = providerSDKRegistry || null;
    this.cacheTtlMs = opts.cacheTtlMs || DEFAULT_CACHE_TTL_MS;
    this._cache = new Map(); // providerId -> { at, models, source }
    this._discovering = false;
    this.lastDiscovery = null;
  }

  /**
   * Get a fresh model set for a single provider, preferring SDK fetchModels().
   * @param {object} provider
   * @returns {Promise<{ok, models, source, error}>}
   * @private
   */
  async _discoverProvider(provider) {
    // SDK path first.
    if (this.bridge && this.bridge.hasSDK(provider)) {
      const adapter = this.bridge.getSDKAdapter(provider);
      if (adapter && typeof adapter.fetchModels === 'function') {
        try {
          const models = await adapter.fetchModels({ timeout: 10000 });
          if (Array.isArray(models) && models.length > 0) {
            return { ok: true, models, source: 'sdk', error: null };
          }
        } catch (err) {
          logger.warn('SDKModelDiscovery: sdk fetchModels failed', { providerId: provider.id, error: err.message });
        }
      }
      // Fallback to manifest models (or provider config models).
      const manifest = this.sdkRegistry && this.sdkRegistry.getManifest(provider.id || provider.adapter);
      const manifestModels = manifest && Array.isArray(manifest.supportedModels) ? manifest.supportedModels : [];
      const configModels = Array.isArray(provider.supportedModels) ? provider.supportedModels : [];
      const fallback = [...new Set([...configModels, ...manifestModels])];
      if (fallback.length > 0) {
        return { ok: true, models: fallback, source: 'manifest', error: null };
      }
      return { ok: false, models: [], source: 'sdk-fallback', error: 'no models from sdk or manifest' };
    }

    // Legacy path.
    if (this.legacyDiscovery && typeof this.legacyDiscovery.discoverProvider === 'function') {
      try {
        const r = await this.legacyDiscovery.discoverProvider(provider);
        return { ok: r.ok, models: r.models, source: 'legacy', error: r.error };
      } catch (err) {
        return { ok: false, models: [], source: 'legacy', error: err.message };
      }
    }
    return { ok: false, models: [], source: 'none', error: 'no discovery method' };
  }

  /**
   * Discover models for all enabled providers, honoring the cache TTL unless
   * `force` is set.
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - bypass cache and re-fetch
   * @returns {Promise<object>} discovery report
   */
  async discover(opts = {}) {
    const force = !!opts.force;
    if (this._discovering) return { at: Date.now(), providers: {}, skipped: true };
    this._discovering = true;
    const providers = this.providerManager.getEnabledProviders();
    const results = {};
    const now = Date.now();

    await Promise.all(providers.map(async (provider) => {
      const cached = this._cache.get(provider.id);
      if (!force && cached && (now - cached.at) < this.cacheTtlMs) {
        // Reuse cached models (still merge into provider config if missing).
        results[provider.id] = { ok: true, count: cached.models.length, source: cached.source, cached: true };
        this._merge(provider, cached.models);
        return;
      }
      const r = await this._discoverProvider(provider);
      results[provider.id] = { ok: r.ok, count: r.models.length, source: r.source, error: r.error };
      if (r.ok) {
        this._cache.set(provider.id, { at: now, models: r.models, source: r.source });
        this._merge(provider, r.models);
        logger.info('SDKModelDiscovery: discovered models', {
          providerId: provider.id, count: r.models.length, source: r.source,
        });
      } else {
        logger.warn('SDKModelDiscovery: failed', { providerId: provider.id, error: r.error });
      }
    }));

    if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
      try { this.modelRegistry.invalidate(); } catch (e) { /* ignore */ }
    }

    this.lastDiscovery = { at: Date.now(), providers: results };
    this._discovering = false;
    return this.lastDiscovery;
  }

  /**
   * Merge discovered models into a provider config (union, dedup) without
   * touching disk.
   * @private
   */
  _merge(provider, models) {
    if (!provider || !Array.isArray(models)) return;
    const existing = Array.isArray(provider.supportedModels) ? provider.supportedModels : [];
    const merged = [...new Set([...existing, ...models])];
    provider.supportedModels = merged;
    provider._discoveredModels = models;
  }

  /**
   * Invalidate a single provider's cache entry (e.g. after a manual refresh
   * or provider reload).
   * @param {string} providerId
   */
  invalidate(providerId) {
    if (providerId) this._cache.delete(providerId);
    else this._cache.clear();
  }

  /** Return the last discovery report. */
  getStatus() {
    return this.lastDiscovery;
  }

  /** Return the current cached model set for a provider (or []). */
  getCached(providerId) {
    const c = this._cache.get(providerId);
    return c ? c.models : [];
  }
}

module.exports = SDKModelDiscovery;
