const GenericOpenAIAdapter = require('./genericOpenAIAdapter');
const OpenAIAdapter = require('./openaiAdapter');
const OpenRouterAdapter = require('./openrouterAdapter');
const TokenFaucetAdapter = require('./tokenFaucetAdapter');
const DeepSeekAdapter = require('./deepSeekAdapter');
const ZenAdapter = require('./zenAdapter');
const DatabricksAdapter = require('./databricksAdapter');
const NvidiaAdapter = require('./nvidiaAdapter');
const GeminiAdapter = require('./geminiAdapter');
const AnthropicAdapter = require('./anthropicAdapter');

/**
 * ProviderAdapterRegistry
 *
 * Maps a provider config to the correct ProviderAdapter instance. The
 * selection rules are:
 *
 *   1. If the provider config has an `adapter` field, use that adapter id
 *      (e.g. "anthropic", "openrouter", "deepseek").
 *   2. Otherwise, try to match the provider `id` to a known adapter id.
 *   3. Otherwise, fall back to GenericOpenAIAdapter (OpenAI-compatible default).
 *
 * Adapters are instantiated lazily and cached per provider object so that the
 * same adapter instance is reused for the lifetime of a provider config.
 *
 * The registry knows nothing about HTTP, retry, or fallback — it only picks
 * the right data-transformation object for a given provider.
 */
class ProviderAdapterRegistry {
  constructor() {
    // id -> adapter class
    this.adapterClasses = new Map();
    // cache: providerId -> adapter instance (re-created on load())
    this.cache = new Map();
    this._registerBuiltins();
  }

  _registerBuiltins() {
    this.register('generic-openai', GenericOpenAIAdapter);
    this.register('openai', OpenAIAdapter);
    this.register('openrouter', OpenRouterAdapter);
    this.register('tokenfaucet', TokenFaucetAdapter);
    this.register('deepseek', DeepSeekAdapter);
    this.register('zen', ZenAdapter);
    this.register('databricks', DatabricksAdapter);
    this.register('nvidia', NvidiaAdapter);
    this.register('gemini', GeminiAdapter);
    this.register('anthropic', AnthropicAdapter);
  }

  /**
   * Register an adapter class under an id. Allows external registration of
   * custom adapters without modifying the registry.
   * @param {string} id
   * @param {Function} AdapterClass
   */
  register(id, AdapterClass) {
    this.adapterClasses.set(id, AdapterClass);
  }

  /**
   * Resolve the adapter id for a provider config.
   * @param {object} provider
   * @returns {string}
   * @private
   */
  _resolveId(provider) {
    if (provider && provider.adapter && typeof provider.adapter === 'string') {
      return provider.adapter;
    }
    if (provider && provider.id && this.adapterClasses.has(provider.id)) {
      return provider.id;
    }
    return 'generic-openai';
  }

  /**
   * Return the adapter instance for a provider config. The instance is cached
   * so repeated calls for the same provider object reuse the same adapter.
   *
   * @param {object} provider - normalized provider config
   * @returns {ProviderAdapter}
   */
  getAdapter(provider) {
    if (!provider || !provider.id) {
      return new GenericOpenAIAdapter(provider);
    }
    const id = this._resolveId(provider);
    const cached = this.cache.get(provider.id);
    if (cached && cached.__adapterId === id) return cached.instance;

    const AdapterClass = this.adapterClasses.get(id) || GenericOpenAIAdapter;
    const instance = new AdapterClass(provider);
    instance.__adapterId = id;
    this.cache.set(provider.id, { __adapterId: id, instance });
    return instance;
  }

  /**
   * Clear the adapter cache. Call after providers are reloaded so new config
   * fields (e.g. a changed `adapter` value) take effect.
   */
  reset() {
    this.cache.clear();
  }
}

module.exports = ProviderAdapterRegistry;
