const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { loadProviders, REQUIRED_FIELDS, validateProviderConfigs } = require('../config/providersConfig');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * ProviderManager
 *
 * Loads, validates, and exposes AI provider configurations at application
 * startup. Providers are read entirely from configuration files (never
 * hardcoded), enabling new providers to be added without touching source
 * code.
 */
class ProviderManager {
  constructor() {
    this.providers = [];
    this.providersById = new Map();
    this.modelToProviders = new Map();
    this.loaded = false;
    this._listeners = [];
    this._configDir = null;
  }

  /**
   * Register a listener that is called whenever the provider configuration
   * is updated (via updateProviders or load). The listener receives the new
   * provider list.
   *
   * @param {Function} fn - (providers: Array<object>) => void
   * @returns {Function} unsubscribe function
   */
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const idx = this._listeners.indexOf(fn);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Notify all registered listeners of a config change.
   * @param {Array<object>} providers
   * @private
   */
  _notify(providers) {
    for (const fn of this._listeners) {
      try { fn(providers); } catch (e) {
        logger.warn('ProviderManager listener error', { error: e && e.message });
      }
    }
  }

  /**
   * Load and validate all provider configs from the configuration directory.
   * Should be called once at application startup.
   *
   * @param {string} [dir] - optional override for the providers config dir
   * @returns {ProviderManager} this instance (for chaining)
   */
  load(dir) {
    this._configDir = dir || null;
    const rawProviders = loadProviders(dir);
    const { valid, errors, warnings, providers } = validateProviderConfigs(rawProviders);

    for (const w of warnings) {
      logger.warn('Provider config warning', { warning: w });
    }
    if (errors.length > 0) {
      for (const e of errors) {
        logger.error('Provider config validation error', { error: e });
      }
    }

    const normalized = providers.map((p) => this._normalize(p));
    this._index(normalized);
    this.loaded = true;

    logger.info('ProviderManager initialized', {
      total: normalized.length,
      enabled: this.getEnabledProviders().length,
    });

    this._notify(normalized);
    return this;
  }

  /**
   * Atomically swap the provider configuration. The new providers are
   * validated before the swap — if validation fails, the previous
   * configuration is kept and an error is thrown.
   *
   * Existing in-flight requests continue with the provider objects they
   * already resolved; new requests use the updated configuration.
   *
   * @param {Array<object>} rawProviders - raw provider configs (post-env-expand)
   * @returns {{ success: boolean, errors: string[], warnings: string[], providers: Array<object> }}
   */
  updateProviders(rawProviders) {
    const { valid, errors, warnings, providers } = validateProviderConfigs(rawProviders);

    if (!valid) {
      // Keep previous configuration — do NOT swap.
      logger.error('Provider config reload failed validation, keeping previous config', {
        errors,
      });
      return { success: false, errors, warnings, providers: [] };
    }

    for (const w of warnings) {
      logger.warn('Provider config warning', { warning: w });
    }

    const normalized = providers.map((p) => this._normalize(p));

    // Atomic swap: replace the indexes in one step.
    this._index(normalized);

    logger.info('ProviderManager reloaded', {
      total: normalized.length,
      enabled: this.getEnabledProviders().length,
    });

    this._notify(normalized);
    return { success: true, errors: [], warnings, providers: normalized };
  }

  /**
   * Normalize a validated provider config (apply defaults).
   * @param {object} raw
   * @returns {object}
   * @private
   */
  _normalize(raw) {
    // Preserve known fields with defaults, and spread any extra provider
    // config fields (e.g. adapter, anthropicVersion, chatPath) so adapters
    // and the adapter registry can read them without changing the manager.
    const base = {
      id: raw.id,
      name: raw.name,
      enabled: raw.enabled !== undefined ? raw.enabled : true,
      baseURL: raw.baseURL,
      apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys : [],
      supportedModels: raw.supportedModels,
      priority: typeof raw.priority === 'number' ? raw.priority : 100,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : DEFAULT_TIMEOUT_MS,
      headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
    };
    // Carry forward unknown fields (adapter, anthropicVersion, chatPath, etc.)
    for (const key of Object.keys(raw)) {
      if (!(key in base) && key !== '__source' && key !== '__invalid' && key !== '__error') {
        base[key] = raw[key];
      }
    }
    return base;
  }

  /**
   * Build internal indexes for fast lookup.
   * @param {Array<object>} providers
   * @private
   */
  _index(providers) {
    this.providers = providers;
    this.providersById = new Map();
    this.modelToProviders = new Map();

    for (const p of providers) {
      this.providersById.set(p.id, p);
      for (const model of p.supportedModels) {
        if (!this.modelToProviders.has(model)) {
          this.modelToProviders.set(model, []);
        }
        this.modelToProviders.get(model).push(p);
      }
    }
  }

  /**
   * Return all loaded providers (enabled + disabled), ordered by priority.
   * @returns {Array<object>}
   */
  listProviders() {
    return [...this.providers].sort((a, b) => a.priority - b.priority);
  }

  /**
   * Return only providers that are enabled, ordered by priority.
   * @returns {Array<object>}
   */
  getEnabledProviders() {
    return this.listProviders().filter((p) => p.enabled);
  }

  /**
   * Find the best enabled provider that supports the given model.
   *
   * Providers are ranked by `priority` (lower number = higher priority).
   * Throws an AppError when no enabled provider supports the model.
   *
   * @param {string} model - model identifier
   * @returns {object} provider config
   */
  getProviderByModel(model) {
    if (!model || typeof model !== 'string') {
      throw new AppError('A model identifier is required', 400, { code: 'INVALID_REQUEST' });
    }

    const candidates = this.modelToProviders.get(model);
    if (!candidates || candidates.length === 0) {
      throw new AppError(`No provider supports model "${model}"`, 404, { code: 'MODEL_NOT_FOUND' });
    }

    const enabled = candidates
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);

    if (enabled.length === 0) {
      throw new AppError(
        `All providers for model "${model}" are disabled`,
        503,
        { code: 'PROVIDER_UNAVAILABLE' }
      );
    }

    return enabled[0];
  }
}

module.exports = ProviderManager;
