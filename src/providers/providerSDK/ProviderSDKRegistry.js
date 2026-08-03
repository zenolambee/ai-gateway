const ProviderManifest = require('./ProviderManifest');
const ProviderAdapterSDK = require('./ProviderAdapterSDK');
const logger = require('../../utils/logger');

/**
 * ProviderSDKRegistry
 *
 * Central registry for the Provider Adapter SDK. Providers register here
 * instead of modifying core gateway files. The registry:
 *   - holds adapter classes indexed by id
 *   - holds manifests (auto-derived from adapter .MANIFEST)
 *   - manages lifecycle (initialize / shutdown)
 *   - supports hot reload (register/unregister at runtime)
 *   - exposes manifests for the dashboard
 *
 * Usage:
 *   const registry = new ProviderSDKRegistry();
 *   registry.register(GrokAdapter);
 *   const adapter = registry.create('grok', providerConfig);
 *   await adapter.initialize();
 *   const manifest = registry.getManifest('grok');
 *   registry.unregister('grok');
 */
class ProviderSDKRegistry {
  constructor() {
    this._classes = new Map();   // id -> { AdapterClass, manifest, initialized }
    this._instances = new Map(); // providerId -> adapter instance
    this._httpClient = null;
  }

  /** Inject the HTTP client for adapters that need it. */
  setHttpClient(client) {
    this._httpClient = client;
  }

  /**
   * Register a provider adapter class.
   * @param {typeof ProviderAdapterSDK} AdapterClass
   * @returns {ProviderSDKRegistry} this
   */
  register(AdapterClass) {
    if (!AdapterClass || typeof AdapterClass !== 'function') {
      throw new Error('ProviderSDKRegistry.register: requires an adapter class');
    }
    const manifest = AdapterClass.MANIFEST;
    if (!manifest || !manifest.id) {
      throw new Error('ProviderSDKRegistry.register: adapter must define a static MANIFEST with an id');
    }
    const id = manifest.id;
    if (this._classes.has(id)) {
      logger.warn('ProviderSDKRegistry: re-registering adapter', { id });
    }
    this._classes.set(id, { AdapterClass, manifest, initialized: false });
    logger.info('ProviderSDKRegistry: registered provider', { id, name: manifest.name });
    return this;
  }

  /**
   * Unregister a provider adapter. If any instances exist, they are shutdown
   * and removed.
   * @param {string} id
   * @returns {boolean}
   */
  unregister(id) {
    // Shutdown all instances for this adapter id.
    for (const [providerId, instance] of this._instances) {
      if (instance.constructor.MANIFEST.id === id) {
        instance.shutdown().catch(() => {});
        this._instances.delete(providerId);
      }
    }
    const had = this._classes.delete(id);
    if (had) logger.info('ProviderSDKRegistry: unregistered provider', { id });
    return had;
  }

  /**
   * Create (or re-use) an adapter instance for a provider config.
   * @param {string} id - adapter manifest id
   * @param {object} providerConfig
   * @returns {ProviderAdapterSDK}
   */
  create(id, providerConfig = {}) {
    const entry = this._classes.get(id);
    if (!entry) throw new Error(`ProviderSDKRegistry: no adapter registered for "${id}"`);
    const providerId = providerConfig.id || id;
    // Cache by provider id so the same provider config reuses the instance.
    if (this._instances.has(providerId)) {
      return this._instances.get(providerId);
    }
    const AdapterClass = entry.AdapterClass;
    const instance = new AdapterClass(providerConfig);
    instance._httpClient = this._httpClient;
    this._instances.set(providerId, instance);
    return instance;
  }

  /**
   * Initialize all registered adapters that haven't been initialized yet.
   * Called at startup. Idempotent.
   * @returns {Promise<{total: number, initialized: number}>}
   */
  async initializeAll() {
    let count = 0;
    for (const [, entry] of this._classes) {
      if (!entry.initialized) {
        try {
          const instance = this.create(entry.manifest.id, { id: entry.manifest.id });
          await instance.initialize();
          entry.initialized = true;
          count += 1;
        } catch (err) {
          logger.error('ProviderSDKRegistry: adapter initialization failed', {
            id: entry.manifest.id, error: err.message,
          });
        }
      }
    }
    logger.info('ProviderSDKRegistry: initialized adapters', { total: this._classes.size, initialized: count });
    return { total: this._classes.size, initialized: count };
  }

  /**
   * Shutdown all adapter instances. Called on shutdown or deregister all.
   * @returns {Promise<number>}
   */
  async shutdownAll() {
    let count = 0;
    for (const [id, instance] of this._instances) {
      try { await instance.shutdown(); count += 1; } catch (_) {}
    }
    this._instances.clear();
    for (const [, entry] of this._classes) entry.initialized = false;
    return count;
  }

  /**
   * Return the manifest for a registered adapter id.
   * @param {string} id
   * @returns {ProviderManifest|null}
   */
  getManifest(id) {
    const entry = this._classes.get(id);
    return entry ? entry.manifest : null;
  }

  /**
   * List all registered manifests (for the dashboard).
   * @returns {Array<object>}
   */
  listManifests() {
    return [...this._classes.values()].map((entry) => entry.manifest.toJSON());
  }

  /** Check if an adapter is registered. */
  has(id) {
    return this._classes.has(id);
  }

  /** Get an existing adapter instance for a provider. */
  getInstance(providerId) {
    return this._instances.get(providerId) || null;
  }

  /** Number of registered adapters. */
  get size() { return this._classes.size; }
}

module.exports = ProviderSDKRegistry;
