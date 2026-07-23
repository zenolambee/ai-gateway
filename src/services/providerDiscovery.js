const logger = require('../utils/logger');

/**
 * ProviderDiscovery
 *
 * Automatically queries each enabled provider's `GET /v1/models` (or the
 * adapter-configured models endpoint) and merges the discovered model ids
 * into the ProviderManager's `supportedModels` list — so the gateway can
 * route to models the provider actually serves without manual config.
 *
 * Discovery is:
 *   - Manual: `discover()` / `discoverProvider(id)` — triggered by the
 *     admin API.
 *   - Scheduled: `startScheduledDiscovery(intervalMs)` — runs on an
 *     unref'd timer.
 *   - Non-blocking: each provider is queried in parallel with a timeout;
 *     a provider failure is logged and skipped (never crashes the
 *     gateway).
 *
 * The discovered model ids are merged with the existing `supportedModels`
 * from the provider config (union, deduplicated). The provider config is
 * NOT mutated on disk — discovery is an in-memory enrichment.
 *
 * Capability detection: after discovering the model ids, the service
 * records the provider's adapter capabilities (streaming, tools, vision,
 * reasoning, embeddings, images, audio, responses) against each model
 * so the ModelRegistry can expose them via the admin API.
 */
class ProviderDiscovery {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager
   * @param {object} deps.httpClient
   * @param {object} deps.adapterRegistry
   * @param {object} [deps.modelRegistry] - to refresh after discovery
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000] - per-provider discovery timeout
   * @param {number} [opts.intervalMs=300000] - scheduled discovery interval (5 min default)
   */
  constructor({ providerManager, httpClient, adapterRegistry, modelRegistry }, opts = {}) {
    this.providerManager = providerManager;
    this.httpClient = httpClient;
    this.adapterRegistry = adapterRegistry;
    this.modelRegistry = modelRegistry || null;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.intervalMs = opts.intervalMs || 300000;
    this._timer = null;
    this._discovering = false;
    this.lastDiscovery = null; // { at, providers: { [id]: { ok, count, error } } }
  }

  /**
   * Discover models for a single provider by querying its models endpoint.
   * Returns the discovered model ids (array of strings). On failure,
   * returns an empty array and records the error.
   *
   * @param {object} provider - provider config
   * @returns {Promise<{ ok: boolean, models: string[], error: string|null }>}
   */
  async discoverProvider(provider) {
    if (!provider || !provider.baseURL) {
      return { ok: false, models: [], error: 'provider has no baseURL' };
    }

    let adapter;
    try {
      adapter = this.adapterRegistry.getAdapter(provider);
    } catch (err) {
      return { ok: false, models: [], error: `adapter error: ${err.message}` };
    }

    // Adapters can override the models endpoint; default is /models.
    const endpoint = (typeof adapter.modelsEndpoint === 'function')
      ? adapter.modelsEndpoint(provider)
      : '/models';

    try {
      const res = await this.httpClient.sendRequest(provider, endpoint, {
        method: 'GET',
        timeout: this.timeoutMs,
      });
      const data = res && res.data;
      const models = this._extractModelIds(data);
      return { ok: true, models, error: null };
    } catch (err) {
      return { ok: false, models: [], error: err && err.message };
    }
  }

  /**
   * Extract model ids from a provider's /models response. Handles the
   * OpenAI shape ({ data: [ { id: "..." } ] }) and a bare array.
   * @param {*} data
   * @returns {string[]}
   * @private
   */
  _extractModelIds(data) {
    if (!data) return [];
    let arr = data;
    if (data && Array.isArray(data.data)) arr = data.data;
    else if (Array.isArray(data)) arr = data;
    else if (data && data.data && Array.isArray(data.data)) arr = data.data;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) => (m && typeof m === 'object' && typeof m.id === 'string' ? m.id : (typeof m === 'string' ? m : null)))
      .filter((m) => m && typeof m === 'string');
  }

  /**
   * Discover models for all enabled providers and merge them into the
   * ProviderManager's supportedModels lists. Also refreshes the
   * ModelRegistry cache so the admin dashboard and /v1/models reflect
   * the new models immediately.
   *
   * @returns {Promise<object>} { at: number, providers: { [id]: { ok, count, error } } }
   */
  async discover() {
    if (this._discovering) {
      // Already running — return the in-flight promise's last result placeholder.
      // (Callers that need the result should await discover() serially.)
      return { at: Date.now(), providers: {}, skipped: true };
    }
    this._discovering = true;
    const providers = this.providerManager.getEnabledProviders();
    const results = {};

    await Promise.all(providers.map(async (provider) => {
      const r = await this.discoverProvider(provider);
      results[provider.id] = { ok: r.ok, count: r.models.length, error: r.error };

      if (r.ok && r.models.length > 0) {
        // Merge discovered models into the provider's supportedModels
        // (union with the existing list, deduplicated). This is an in-memory
        // enrichment — the on-disk config is not modified.
        const existing = Array.isArray(provider.supportedModels) ? provider.supportedModels : [];
        const merged = [...new Set([...existing, ...r.models])];
        provider.supportedModels = merged;
        provider._discoveredModels = r.models;
        logger.info('ProviderDiscovery: discovered models', {
          providerId: provider.id,
          count: r.models.length,
          total: merged.length,
        });
      } else if (!r.ok) {
        logger.warn('ProviderDiscovery: failed for provider', {
          providerId: provider.id,
          error: r.error,
        });
      }
    }));

    // Refresh the model registry so the new models appear immediately.
    if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
      try { this.modelRegistry.invalidate(); } catch (e) { /* ignore */ }
    }

    this.lastDiscovery = { at: Date.now(), providers: results };
    this._discovering = false;
    return this.lastDiscovery;
  }

  /**
   * Start scheduled discovery on an interval. The timer is unref'd so it
   * never keeps the process alive.
   * @param {number} [intervalMs] - override the default interval
   */
  startScheduledDiscovery(intervalMs) {
    this.stopScheduledDiscovery();
    if (intervalMs) this.intervalMs = intervalMs;
    if (this.intervalMs <= 0) return;
    this._timer = setInterval(() => {
      this.discover().catch((err) => {
        logger.warn('ProviderDiscovery: scheduled discovery crashed', { error: err && err.message });
      });
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    logger.info('ProviderDiscovery: scheduled discovery started', { intervalMs: this.intervalMs });
  }

  /**
   * Stop scheduled discovery.
   */
  stopScheduledDiscovery() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Detect capabilities for a model from the adapter of each provider that
   * serves it. Returns a merged capability object (union across providers).
   *
   * @param {string} modelId
   * @returns {object} capability flags
   */
  detectCapabilities(modelId) {
    const caps = {
      chat: false,
      responses: false,
      streaming: false,
      embeddings: false,
      images: false,
      audio: false,
      tools: false,
      reasoning: false,
      vision: false,
    };
    const providers = this.providerManager.getEnabledProviders();
    for (const p of providers) {
      if (!p.supportedModels || !p.supportedModels.includes(modelId)) continue;
      let adapter;
      try { adapter = this.adapterRegistry.getAdapter(p); } catch { continue; }
      const c = (typeof adapter.capabilityInfo === 'function') ? adapter.capabilityInfo() : {};
      if (c.chat) caps.chat = true;
      if (c.responses) caps.responses = true;
      if (c.streaming) caps.streaming = true;
      if (c.embeddings) caps.embeddings = true;
      if (c.images) caps.images = true;
      if (c.audio) caps.audio = true;
      if (c.tools) caps.tools = true;
      if (c.reasoning) caps.reasoning = true;
      // Vision: infer from the adapter or the model id heuristics
      if (typeof adapter.capabilities === 'function') {
        const full = adapter.capabilities();
        if (full.supportsVision) caps.vision = true;
      }
      if (/vision|gpt-4o|gpt-4-turbo|claude-3|gemini/i.test(modelId)) caps.vision = true;
    }
    return caps;
  }

  /**
   * Return the last discovery status (for the admin dashboard).
   * @returns {object|null}
   */
  getStatus() {
    return this.lastDiscovery;
  }
}

module.exports = ProviderDiscovery;
