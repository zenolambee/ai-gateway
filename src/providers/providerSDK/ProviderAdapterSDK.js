const ProviderAdapter = require('../providerAdapter');
const ProviderManifest = require('./ProviderManifest');
const logger = require('../../utils/logger');

/**
 * ProviderAdapterSDK
 *
 * The standard base class for the Provider Adapter SDK. Every provider adapter
 * MUST implement the full lifecycle:
 *
 *   initialize()    — prepare resources (called once at startup or on register)
 *   connect()       — establish an authenticated session (account-based)
 *   disconnect()    — tear down the session / revoke credentials
 *   refresh()       — refresh an expiring credential
 *   validate()      — boolean: is the current credential usable?
 *   listModels()    — return list of model ids this provider serves
 *   healthCheck()   — test connectivity & return { healthy, latencyMs, error? }
 *   sendRequest()   — send a provider-specific API request
 *   shutdown()      — clean up resources (called on deregister or process exit)
 *
 * Plus the existing ProviderAdapter data-transformation methods:
 *   buildChatPayload / normalizeChatResponse / buildHeaders / etc.
 *
 * Each adapter also defines a static MANIFEST property (ProviderManifest
 * instance) with the provider's metadata.
 *
 * Auth support is provider-scoped via the authAdapterFactory: a provider
 * adapter that needs OAuth, Device Code, etc. simply registers with the
 * factory using authAdapterFactory.registerProvider(this.MANIFEST).
 * No core gateway file changes are required.
 */
class ProviderAdapterSDK extends ProviderAdapter {
  /**
   * @param {object} provider - normalized provider config
   */
  constructor(provider) {
    super(provider);
    this._initialized = false;
    this._connected = false;
    this._healthCache = null;
  }

  /** Subclasses MUST override to return their ProviderManifest. */
  static get MANIFEST() {
    throw new Error('ProviderAdapterSDK subclasses must define a static MANIFEST');
  }

  /** Convenience: return the manifest instance (or construct from subclass). */
  get manifest() {
    return this.constructor.MANIFEST;
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  /**
   * Initialize the adapter. Called once at registration or startup.
   * Set up resources, configuration, etc.
   * @returns {Promise<void>}
   */
  async initialize() {
    this._initialized = true;
    this._log('initialize');
  }

  /**
   * Connect an account for this provider.
   * @param {object} config - { authType, apiKey?, accessToken?, ... }
   * @returns {Promise<object>} account descriptor
   */
  async connect(config = {}) {
    // Default: store an API key on the provider config.
    if (config.apiKey) {
      this.provider.apiKeys = [config.apiKey];
      this._connected = true;
      this._log('connect (api-key)');
      return { providerId: this.provider.id, accountId: this.provider.id, authType: 'api-key', connected: true };
    }
    this._connected = true;
    return { providerId: this.provider.id, accountId: this.provider.id, connected: true };
  }

  /**
   * Disconnect / revoke the current credential.
   * @param {object} [account]
   * @returns {Promise<string|null>} account id or null
   */
  async disconnect(account) {
    this._connected = false;
    // Clear the credential so validate() returns false.
    if (this.provider) {
      this.provider.apiKeys = [];
    }
    this._log('disconnect');
    return account ? account.accountId || this.provider.id : this.provider.id;
  }

  /**
   * Refresh an expiring credential. By default this is a no-op when
   * the provider uses a static API key.
   * @param {object} account
   * @returns {Promise<object>}
   */
  async refresh(account) {
    this._connected = true;
    return account || { providerId: this.provider.id, connected: true };
  }

  /**
   * Whether the current credential is still usable.
   * @param {object} [account]
   * @returns {boolean}
   */
  validate(account) {
    if (this.provider && Array.isArray(this.provider.apiKeys) && this.provider.apiKeys.length > 0) return true;
    if (account && account.credential) return true;
    return false;
  }

  /**
   * List models this provider serves. Synchronous (matches the base
   * ProviderAdapter contract). Reads from the provider config's
   * supportedModels array. Live adapters use fetchModels() for async
   * retrieval.
   * @param {object} [provider]
   * @returns {Array<string>}
   */
  listModels(provider) {
    const models = super.listModels(provider);
    if (Array.isArray(models)) return models;
    const p = provider || this.provider;
    if (p && Array.isArray(p.supportedModels)) {
      return [...new Set(p.supportedModels.filter((m) => typeof m === 'string' && m))];
    }
    return [];
  }

  /**
   * Fetch the live model list from the provider's /models endpoint (async).
   * @param {object} [opts] - { timeout }
   * @returns {Promise<Array<string>>} model ids (or [] on failure)
   */
  async fetchModels(opts = {}) {
    const client = this._httpClient || null;
    if (!client || !this.provider || !this.provider.baseURL) return [];
    try {
      const res = await client.request({
        url: `${this.provider.baseURL.replace(/\/+$/, '')}/models`,
        method: 'GET',
        timeout: opts.timeout || 5000,
        raw: true,
      });
      if (res.status >= 400) return [];
      const data = res.data || {};
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      return list.map((m) => (typeof m === 'string' ? m : (m && m.id) || null)).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  /**
   * Health check: verify the provider is reachable and returning valid
   * responses.
   * @param {object} [opts] - { timeout }
   * @returns {Promise<{ healthy: boolean, latencyMs: number, error?: string }>}
   */
  async healthCheck(opts = {}) {
    const client = this._httpClient || null;
    if (!client || !this.provider || !this.provider.baseURL) {
      return { healthy: false, latencyMs: 0, error: 'No HTTP client or baseURL configured' };
    }
    const started = Date.now();
    try {
      const res = await client.request({
        url: `${this.provider.baseURL.replace(/\/+$/, '')}/models`,
        method: 'GET',
        timeout: opts.timeout || 5000,
        raw: true,
      });
      const latency = Date.now() - started;
      const healthy = res.status < 500;
      this._healthCache = { healthy, latencyMs: latency, status: res.status };
      return { healthy, latencyMs: latency, status: res.status };
    } catch (err) {
      const latency = Date.now() - started;
      this._healthCache = { healthy: false, latencyMs: latency, error: err.message };
      return { healthy: false, latencyMs: latency, error: err.message };
    }
  }

  /**
   * Send a provider-specific request. The base implementation delegates to
   * httpClient.sendRequest (which resolves/rotates the API key and builds the
   * full header set). Subclasses may transform the payload before sending.
   * @param {object} req - { endpoint, method, body, headers, timeout, responseType }
   * @returns {Promise<{status,headers,data,_resolvedApiKey}>}
   */
  async sendRequest(req = {}) {
    const client = this._httpClient || null;
    if (!client) {
      throw new Error('ProviderAdapterSDK: no HTTP client available');
    }
    return client.sendRequest(this.provider, req.endpoint || '/', {
      method: req.method || 'POST',
      body: req.body,
      headers: req.headers,
      auth: req.auth,
      timeout: req.timeout || (this.provider.timeout || 30000),
      responseType: req.responseType,
    });
  }

  /**
   * Shutdown the adapter. Release resources.
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._initialized = false;
    this._connected = false;
    this._healthCache = null;
    this._log('shutdown');
  }

  // ---------------------------------------------------------------
  // Capabilities (override the base ProviderAdapter shape with SDK extras)
  // ---------------------------------------------------------------

  capabilities() {
    const m = this.manifest;
    return {
      supportsChat: true,
      supportsResponses: true,
      supportsStreaming: m.supportsStreaming,
      supportsEmbeddings: m.supportsEmbeddings,
      supportsImages: m.supportsImages,
      supportsAudio: m.supportsAudio,
      supportsTools: m.supportsTools,
      supportsVision: m.supportsVision,
      supportsReasoning: !!m.supportedAuth && m.supportedAuth.includes('oauth'), // heuristic
    };
  }

  // ---------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------

  _log(msg) {
    logger.info(`ProviderAdapterSDK(${this.provider?.id || 'unknown'}): ${msg}`);
  }
}

module.exports = ProviderAdapterSDK;
