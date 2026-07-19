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
   * @param {object} [opts]
   * @param {number} [opts.cacheTtlMs=60000] - cache time-to-live in ms
   */
  constructor({ providerManager, adapterRegistry }, opts = {}) {
    if (!providerManager) throw new Error('ModelRegistry requires a providerManager');
    if (!adapterRegistry) throw new Error('ModelRegistry requires an adapterRegistry');
    this.providerManager = providerManager;
    this.adapterRegistry = adapterRegistry;
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

        for (const modelId of models) {
          if (byId.has(modelId)) {
            // Deduplicate: merge provider ids + capabilities (union).
            const existing = byId.get(modelId);
            existing.providers.push(provider.id);
            existing._providers.push({ id: provider.id, name: provider.name, priority: provider.priority });
            this._mergeCaps(existing.capabilities, caps);
          } else {
            byId.set(modelId, {
              id: modelId,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: provider.id,
              // Internal metadata (not exposed in the OpenAI response):
              providers: [provider.id],
              _providers: [{ id: provider.id, name: provider.name, priority: provider.priority }],
              capabilities: { ...caps },
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
}

module.exports = ModelRegistry;
module.exports.DEFAULT_CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
