const logger = require('../../utils/logger');

/**
 * SDKRoutingBridge
 *
 * Bridges provider routing between the ProviderAdapterSDK and the legacy
 * ProviderAdapter/httpClient path. The RequestExecutor consults this bridge
 * for the actual provider request: if the provider maps to a registered SDK
 * adapter, it routes through the SDK's `sendRequest()` / `streamRequest()`;
 * otherwise it signals "use legacy" and the executor falls back to the
 * unchanged httpClient path.
 *
 * The bridge never changes the executor's public API or the legacy contract —
 * it only adds an SDK-first path that the executor can opt into via a
 * late-bound `sdkRouter`.
 *
 * Capability-aware routing: the bridge exposes provider capabilities derived
 * from each SDK adapter's MANIFEST, so the ModelRouter can filter candidates
 * by required capability.
 */
class SDKRoutingBridge {
  /**
   * @param {object} opts
   * @param {ProviderSDKRegistry} opts.sdkRegistry
   * @param {object} [opts.httpClient]
   */
  constructor({ sdkRegistry, httpClient } = {}) {
    this.sdkRegistry = sdkRegistry || null;
    this.httpClient = httpClient || null;
    this._instanceCache = new Map(); // providerId -> adapter instance
  }

  /**
   * Resolve the provider id to use for SDK lookup.
   * Order: explicit `adapter` field (mapped), else provider.id.
   * @private
   */
  _resolveId(provider) {
    if (!provider) return null;
    if (provider.adapter && typeof provider.adapter === 'string' && this.sdkRegistry && this.sdkRegistry.has(provider.adapter)) {
      return provider.adapter;
    }
    if (provider.id && this.sdkRegistry && this.sdkRegistry.has(provider.id)) {
      return provider.id;
    }
    return null;
  }

  /**
   * Get the SDK adapter instance for a provider, or null when the provider
   * has no registered SDK adapter (=> use legacy routing).
   * @param {object} provider
   * @returns {object|null} SDK adapter instance
   */
  getSDKAdapter(provider) {
    const id = this._resolveId(provider);
    if (!id || !this.sdkRegistry) return null;
    try {
      const providerId = provider && provider.id ? provider.id : id;
      if (this._instanceCache.has(providerId)) {
        return this._instanceCache.get(providerId);
      }
      const instance = this.sdkRegistry.create(id, provider);
      instance._httpClient = this.httpClient || instance._httpClient;
      this._instanceCache.set(providerId, instance);
      return instance;
    } catch (err) {
      logger.warn('SDKRoutingBridge: could not create SDK adapter', { id, error: err.message });
      return null;
    }
  }

  /** Whether the provider should be routed through the SDK. */
  hasSDK(provider) {
    return this.getSDKAdapter(provider) !== null;
  }

  /**
   * Return the capability object for a provider (from SDK manifest), or null
   * when the provider has no SDK manifest (legacy).
   * @param {object} provider
   * @returns {object|null}
   */
  capabilities(provider) {
    const id = this._resolveId(provider);
    if (!id || !this.sdkRegistry) return null;
    const manifest = this.sdkRegistry.getManifest(id);
    if (!manifest) return null;
    return {
      chat: true,
      responses: true,
      streaming: manifest.supportsStreaming,
      embeddings: manifest.supportsEmbeddings,
      images: manifest.supportsImages,
      audio: manifest.supportsAudio,
      tools: manifest.supportsTools,
      vision: manifest.supportsVision,
      reasoning: manifest.reasoning || false,
    };
  }

  /**
   * Whether a provider supports a specific capability (via its SDK manifest).
   * Returns null when the provider has no SDK adapter (unknown → caller should
   * not filter on capability).
   * @param {object} provider
   * @param {string} capability - chat|responses|embeddings|images|audio|tools|vision|streaming
   * @returns {boolean|null}
   */
  supportsCapability(provider, capability) {
    const caps = this.capabilities(provider);
    if (!caps) return null;
    return !!caps[capability];
  }

  /**
   * Send a request through the SDK adapter. Returns the same response shape
   * as httpClient.sendRequest: { status, headers, data, _resolvedApiKey }.
   * @param {object} provider
   * @param {string} endpoint
   * @param {object} opts - { method, body, headers, responseType, timeout }
   * @returns {Promise<object>}
   */
  async sendRequest(provider, endpoint, opts = {}) {
    const adapter = this.getSDKAdapter(provider);
    if (!adapter) throw new Error('SDKRoutingBridge: no SDK adapter for provider');
    return adapter.sendRequest({
      endpoint,
      method: opts.method || 'POST',
      body: opts.body,
      headers: opts.headers,
      responseType: opts.responseType,
      timeout: opts.timeout || (provider.timeout || 30000),
    });
  }

  /** Invalidate per-provider SDK adapter instance cache (on provider reload). */
  reset() {
    this._instanceCache.clear();
  }
}

module.exports = SDKRoutingBridge;
