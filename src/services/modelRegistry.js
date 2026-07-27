const logger = require('../utils/logger');

const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * ModelRegistry
 *
 * Aggregates the model catalogues of every enabled provider into a single
 * unified, deduplicated registry exposed via the OpenAI-compatible
 * `GET /v1/models` and `GET /v1/models/:id` endpoints.
 *
 * Responsibilities:
 *   - Ask each provider's adapter for its model list (`listModels()`).
 *   - Deduplicate identical model ids across providers (a model served by
 *     more than one provider appears once, with provider metadata tracked
 *     internally).
 *   - Track per-model capabilities (chat, embeddings, images, audio, tools,
 *     streaming, reasoning) derived from the serving provider's adapter.
 *   - Cache the aggregated list with a configurable TTL; allow manual
 *     refresh.
 *   - Continue collecting models from remaining providers if one fails
 *     (a provider throwing in `listModels` never breaks the whole registry).
 *
 * The registry stores rich internal metadata (provider ids, capabilities)
 * but only exposes the OpenAI-compatible `{ id, object, created, owned_by }`
 * shape to clients. The internal metadata is available via `getInternal()`
 * for gateway components (e.g. the Models route or future admin endpoints).
 *
 * No HTTP, no retry — the registry only reads from the ProviderManager and
 * the adapter registry, both of which are in-memory.
 */
class ModelRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager - ProviderManager instance
   * @param {object} deps.adapterRegistry - ProviderAdapterRegistry instance
   * @param {object} [deps.aliasResolver] - ModelAliasResolver instance
   * @param {object} [deps.healthMonitor] - ProviderHealthMonitor for health/latency enrichment
   * @param {object} [deps.discovery] - ProviderDiscovery for capability detection
   * @param {object} [deps.virtualModelRegistry] - VirtualModelRegistry (Sprint 11);
   *   when attached, virtual models are merged into the /v1/models catalog so
   *   clients can discover them like any other model.
   * @param {object} [opts]
   * @param {number} [opts.cacheTtlMs=60000] - cache time-to-live in ms
   */
  constructor({ providerManager, adapterRegistry, aliasResolver, healthMonitor, discovery, virtualModelRegistry }, opts = {}) {
    if (!providerManager) throw new Error('ModelRegistry requires a providerManager');
    if (!adapterRegistry) throw new Error('ModelRegistry requires an adapterRegistry');
    this.providerManager = providerManager;
    this.adapterRegistry = adapterRegistry;
    this.aliasResolver = aliasResolver || null;
    this.healthMonitor = healthMonitor || null;
    this.discovery = discovery || null;
    this.virtualModelRegistry = virtualModelRegistry || null;
    this.cacheTtlMs = typeof opts.cacheTtlMs === 'number' ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;

    // cache state
    this._cache = null;       // { entries: Array<internalEntry>, byId: Map, expiresAt: number }
    this._refreshing = null;  // in-flight refresh promise (de-duplicates concurrent refreshes)
  }

  /**
   * Force a fresh aggregation of all provider model catalogues, bypassing
   * the cache. Safe to call multiple times concurrently — concurrent calls
   * share a single refresh promise.
   *
   * @returns {Promise<Array<object>>} the aggregated internal entries
   */
  async refresh() {
    if (this._refreshing) return this._refreshing;
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  /**
   * Perform the actual aggregation. Iterates over enabled providers, asks
   * each adapter for its model list, and deduplicates by model id. A
   * provider that throws is logged and skipped — the remaining providers
   * are still collected.
   *
   * @returns {Promise<Array<object>>}
   * @private
   */
  async _doRefresh() {
    const providers = this.providerManager.getEnabledProviders();
    const byId = new Map(); // modelId -> internalEntry
    const health = this.healthMonitor ? this.healthMonitor.getAllHealth() : {};

    for (const provider of providers) {
      try {
        const adapter = this.adapterRegistry.getAdapter(provider);
        let models = [];
        try {
          const result = adapter.listModels(provider);
          models = Array.isArray(result) ? result : [];
        } catch (e) {
          logger.warn('ModelRegistry: adapter.listModels failed', {
            providerId: provider.id,
            error: e && e.message,
          });
          continue;
        }

        const caps = typeof adapter.capabilityInfo === 'function'
          ? adapter.capabilityInfo()
          : this._capsFromAdapter(adapter);

        // Per-provider context length (optional; from config or adapter)
        const contextLength = provider.contextLength || (adapter.contextLength ? adapter.contextLength(provider) : undefined);

        // Per-provider endpoint (chat completions path)
        let endpoint;
        try { endpoint = adapter.chatEndpoint(provider); } catch { endpoint = '/chat/completions'; }

        const providerHealth = health[provider.id] || null;

        for (const modelId of models) {
          if (byId.has(modelId)) {
            // Deduplicate: merge provider ids + capabilities (union).
            const existing = byId.get(modelId);
            existing.providers.push(provider.id);
            existing._providers.push({
              id: provider.id, name: provider.name, priority: provider.priority,
              weight: provider.weight || 1,
              endpoint,
              contextLength,
              health: providerHealth,
              latency: providerHealth ? providerHealth.averageLatencyMs : 0,
              successRate: providerHealth ? providerHealth.successRate : 100,
            });
            this._mergeCaps(existing.capabilities, caps);
            // Merge per-provider priority/latency for the aggregated entry.
            existing.latency = Math.min(existing.latency || Infinity, providerHealth ? providerHealth.averageLatencyMs : 0);
            existing.successRate = Math.min(existing.successRate || 100, providerHealth ? providerHealth.successRate : 100);
          } else {
            byId.set(modelId, {
              id: modelId,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: provider.id,
              // Internal metadata (not exposed in the OpenAI response):
              providers: [provider.id],
              _providers: [{
                id: provider.id, name: provider.name, priority: provider.priority,
                weight: provider.weight || 1,
                endpoint,
                contextLength,
                health: providerHealth,
                latency: providerHealth ? providerHealth.averageLatencyMs : 0,
                successRate: providerHealth ? providerHealth.successRate : 100,
              }],
              capabilities: { ...caps },
              // Aggregated health (best across providers)
              latency: providerHealth ? providerHealth.averageLatencyMs : 0,
              successRate: providerHealth ? providerHealth.successRate : 100,
              priority: provider.priority,
              // Aliases that resolve to this model (filled below)
              aliases: [],
            });
          }
        }
      } catch (e) {
        // A provider failure must never break the whole registry.
        logger.warn('ModelRegistry: provider aggregation failed', {
          providerId: provider && provider.id,
          error: e && e.message,
        });
      }
    }

    // Enrich entries with aliases (reverse lookup from the alias resolver).
    if (this.aliasResolver) {
      for (const entry of byId.values()) {
        entry.aliases = this.aliasResolver.aliasesForModel(entry.id);
      }
    }

    // Merge virtual models (Sprint 11). Each enabled virtual model becomes a
    // catalog entry (object: 'model') so OpenAI clients can discover and
    // request it alongside real models. The backing real-model candidates
    // are recorded under _providers; clients never see provider internals.
    if (this.virtualModelRegistry) {
      const vms = this.virtualModelRegistry.listVirtualModels();
      for (const vm of vms) {
        if (!vm.enabled) continue;
        if (byId.has(vm.id)) {
          // A real model already shares the id — keep the real one and skip
          // (a virtual id should not shadow a real model id).
          continue;
        }
        const backing = [];
        for (const c of vm.candidates) {
          if (!c.enabled) continue;
          const real = byId.get(c.model);
          backing.push({
            providerId: c.provider,
            model: c.model,
            priority: c.priority,
            weight: c.weight,
            capabilities: real ? real.capabilities : {},
          });
        }
        // Capability union across enabled candidates' real models.
        const capabilities = {};
        for (const b of backing) {
          if (b.capabilities) this._mergeCaps(capabilities, b.capabilities);
        }
        byId.set(vm.id, {
          id: vm.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'gateway',
          providers: vm.candidates.filter((c) => c.enabled).map((c) => c.provider),
          _providers: backing,
          capabilities,
          latency: 0,
          successRate: 100,
          priority: 100,
          aliases: [],
          virtual: true,
          strategy: vm.strategy,
        });
      }
    }

    const entries = [...byId.values()];
    // Sort by model id for stable output.
    entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    this._cache = {
      entries,
      byId,
      expiresAt: Date.now() + this.cacheTtlMs,
    };

    logger.info('ModelRegistry refreshed', {
      providers: providers.length,
      models: entries.length,
    });

    return entries;
  }

  /**
   * Get the aggregated list of internal entries, using the cache when fresh
   * and refreshing transparently when stale.
   *
   * @returns {Promise<Array<object>>}
   */
  async getEntries() {
    if (this._cache && Date.now() < this._cache.expiresAt) {
      return this._cache.entries;
    }
    return this.refresh();
  }

  /**
   * Get a single internal entry by model id (using the cache).
   *
   * @param {string} modelId
   * @returns {Promise<object|null>}
   */
  async getEntry(modelId) {
    const entries = await this.getEntries();
    const byId = this._cache && this._cache.byId;
    if (byId) return byId.get(modelId) || null;
    return entries.find((e) => e.id === modelId) || null;
  }

  /**
   * Return the OpenAI-compatible list response for `GET /v1/models`.
   * Exposes only `{ id, object, created, owned_by }` per model — internal
   * metadata (providers, capabilities) is stripped.
   *
   * @returns {Promise<{object:string, data:Array<object>}>}
   */
  async listModelsResponse() {
    const entries = await this.getEntries();
    return {
      object: 'list',
      data: entries.map((e) => this._toOpenAIModel(e)),
    };
  }

  /**
   * Return the OpenAI-compatible single-model response for
   * `GET /v1/models/:id`. Returns null when the model is not found.
   *
   * @param {string} modelId
   * @returns {Promise<object|null>}
   */
  async getModelResponse(modelId) {
    const entry = await this.getEntry(modelId);
    if (!entry) return null;
    return this._toOpenAIModel(entry);
  }

  /**
   * Invalidate the cache. The next `listModelsResponse` / `getEntry` call
   * triggers a fresh aggregation.
   */
  invalidate() {
    this._cache = null;
  }

  /**
   * Whether the cache currently holds a fresh (non-expired) entry list.
   * @returns {boolean}
   */
  isCacheFresh() {
    return !!this._cache && Date.now() < this._cache.expiresAt;
  }

  /**
   * Project an internal entry to the OpenAI-compatible model object.
   * @param {object} entry
   * @returns {object}
   * @private
   */
  _toOpenAIModel(entry) {
    return {
      id: entry.id,
      object: 'model',
      created: entry.created,
      owned_by: entry.owned_by,
    };
  }

  /**
   * Fallback capability extractor for adapters that don't implement
   * `capabilityInfo()` (should not happen with built-in adapters, but keeps
   * the registry robust against custom adapters).
   * @param {object} adapter
   * @returns {object}
   * @private
   */
  _capsFromAdapter(adapter) {
    const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : {};
    return {
      chat: !!caps.supportsChat,
      responses: !!caps.supportsResponses,
      streaming: !!caps.supportsStreaming,
      embeddings: !!caps.supportsEmbeddings,
      images: !!caps.supportsImages,
      audio: !!caps.supportsAudio,
      tools: !!caps.supportsTools,
      reasoning: !!caps.supportsReasoning,
    };
  }

  /**
   * Merge (union) a source capability set into a target.
   * @param {object} target
   * @param {object} source
   * @private
   */
  _mergeCaps(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key]) target[key] = true;
    }
  }

  // ---------------------------------------------------------------
  // Rich / admin-facing API (Sprint 10)
  // ---------------------------------------------------------------

  /**
   * Return the aggregated list of rich model entries (for the admin
   * dashboard). Each entry includes the full internal metadata:
   * providers, capabilities, aliases, health, latency, success rate,
   * priority, context length, endpoint.
   *
   * @returns {Promise<Array<object>>}
   */
  async getRichEntries() {
    const entries = await this.getEntries();
    return entries.map((e) => this._toRichModel(e));
  }

  /**
   * Return a single rich model entry by id (for the admin dashboard).
   * Returns null when the model is not found.
   *
   * @param {string} modelId
   * @returns {Promise<object|null>}
   */
  async getRichEntry(modelId) {
    const entry = await this.getEntry(modelId);
    if (!entry) return null;
    return this._toRichModel(entry);
  }

  /**
   * Project an internal entry to the rich model shape for the admin API.
   * @param {object} entry
   * @returns {object}
   * @private
   */
  _toRichModel(entry) {
    if (entry.virtual) {
      return {
        id: entry.id,
        object: 'model',
        created: entry.created,
        owned_by: entry.owned_by,
        virtual: true,
        strategy: entry.strategy || 'priority',
        providers: (entry._providers || []).map((p) => ({
          providerId: p.providerId,
          model: p.model,
          priority: p.priority,
          weight: p.weight,
        })),
        capabilities: { ...(entry.capabilities || {}) },
      };
    }
    return {
      id: entry.id,
      object: 'model',
      created: entry.created,
      owned_by: entry.owned_by,
      aliases: entry.aliases || [],
      providers: (entry._providers || []).map((p) => ({
        id: p.id,
        name: p.name,
        priority: p.priority,
        weight: p.weight || 1,
        endpoint: p.endpoint,
        contextLength: p.contextLength,
        latency: p.latency || 0,
        successRate: p.successRate || 100,
        health: p.health || null,
      })),
      capabilities: { ...(entry.capabilities || {}) },
      // Aggregated health across providers
      latency: entry.latency || 0,
      successRate: entry.successRate || 100,
      priority: entry.priority,
    };
  }
}

module.exports = ModelRegistry;
module.exports.DEFAULT_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
