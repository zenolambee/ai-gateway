const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { loadProviders } = require('../config/providersConfig');
const { loadVirtualModelsConfig, saveVirtualModelsConfig, validateVirtualModelsConfig } = require('../config/virtualModelsConfig');

/**
 * ProviderConfigManager
 *
 * Watches the provider configuration directory for changes and triggers a
 * hot reload of the ProviderManager (and the entire reload cascade) when a
 * file is added, changed, or removed. No process restart is required.
 *
 * The reload is atomic: the new config is validated before the swap. If
 * validation fails, the previous configuration is kept and the error is
 * logged. The reload cascade (adapter cache reset, API key reload, model
 * registry invalidation, health monitor reset) runs only on a successful
 * swap.
 *
 * Existing in-flight requests continue normally — they use the provider
 * objects they already resolved. New requests use the updated configuration.
 *
 * The watcher uses a short debounce (100ms) to batch rapid file changes
 * (e.g. an editor that writes multiple files at once).
 */
class ProviderConfigManager {
  /**
   * @param {object} deps
   * @param {object} deps.providerManager - ProviderManager instance
   * @param {object} [deps.adapterRegistry] - for cache reset on reload
   * @param {object} [deps.apiKeyManager] - for key reload on reload
   * @param {object} [deps.modelRegistry] - for cache invalidation
   * @param {object} [deps.healthMonitor] - for health state reset
   * @param {object} [deps.metricsCollector] - for reload metrics
   * @param {object} [deps.modelRouter] - for routing strategy re-application
   * @param {object} [deps.routingConfig] - current routing config
   * @param {object} [opts]
   * @param {number} [opts.debounceMs=100] - debounce for file-watch events
   * @param {boolean} [opts.watch=true] - whether to start watching
   */
  constructor({
    providerManager,
    adapterRegistry,
    apiKeyManager,
    modelRegistry,
    healthMonitor,
    metricsCollector,
    modelRouter,
    routingConfig,
    aliasResolver,
    ruleEngine,
    discovery,
    virtualModelRegistry,
  } = {}, opts = {}) {
    this.providerManager = providerManager;
    this.adapterRegistry = adapterRegistry || null;
    this.apiKeyManager = apiKeyManager || null;
    this.modelRegistry = modelRegistry || null;
    this.healthMonitor = healthMonitor || null;
    this.metricsCollector = metricsCollector || null;
    this.modelRouter = modelRouter || null;
    this.routingConfig = routingConfig || null;
    this.aliasResolver = aliasResolver || null;
    this.ruleEngine = ruleEngine || null;
    this.discovery = discovery || null;
    this.virtualModelRegistry = virtualModelRegistry || null;

    this.debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 100;
    this._watcher = null;
    this._parentWatcher = null;
    this._debounceTimer = null;
    this._reloadCount = 0;
    this._reloadFailures = 0;
  }

  /**
   * Start watching the provider config directory for changes.
   */
  startWatching() {
    const dir = this.providerManager.getConfigDir()
      || path.join(process.cwd(), 'config', 'providers');

    if (!fs.existsSync(dir)) {
      logger.warn('ProviderConfigManager: config directory not found, not watching', { dir });
      return;
    }

    try {
      this._watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        this._scheduleReload();
      });
      if (this._watcher.unref) this._watcher.unref();
      logger.info('ProviderConfigManager: watching for changes', { dir });
    } catch (err) {
      logger.error('ProviderConfigManager: failed to start watcher', { error: err.message });
    }

    // Also watch the parent config dir for top-level config files that are
    // not under config/providers/ (e.g. config/virtualModels.json,
    // config/aliases.json). The provider-dir watcher above does not see those.
    const parentDir = path.dirname(dir);
    try {
      this._parentWatcher = fs.watch(parentDir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        // Hot reload only the config files we know how to reload.
        if (filename === 'virtualModels.json') {
          this.reloadVirtualModels();
          return;
        }
        if (filename === 'aliases.json' || filename === 'routingRules.json' || filename === 'routing.json') {
          this._scheduleReload();
        }
      });
      if (this._parentWatcher && this._parentWatcher.unref) this._parentWatcher.unref();
    } catch (err) {
      logger.warn('ProviderConfigManager: failed to watch parent config dir', { error: err.message });
    }
  }

  /**
   * Stop watching the config directories.
   */
  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._parentWatcher) {
      this._parentWatcher.close();
      this._parentWatcher = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  /**
   * Schedule a debounced reload. Multiple file changes within the debounce
   * window are batched into a single reload.
   * @private
   */
  _scheduleReload() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.reload().catch((err) => {
        logger.error('ProviderConfigManager: reload crashed', { error: err && err.message });
      });
    }, this.debounceMs);
  }

  /**
   * Reload provider configurations from disk, validate, and atomically swap.
   * On validation failure, keep the previous configuration.
   *
   * @returns {Promise<{ success: boolean, errors: string[], warnings: string[] }>}
   */
  async reload() {
    const dir = this.providerManager.getConfigDir()
      || path.join(process.cwd(), 'config', 'providers');

    logger.info('ProviderConfigManager: reloading provider configuration', { dir });

    // 1. Load raw configs from disk (with env expansion).
    const rawProviders = loadProviders(dir);

    // 2. Atomically swap in the ProviderManager (validates first).
    const result = this.providerManager.updateProviders(rawProviders);

    if (!result.success) {
      this._reloadFailures += 1;
      if (this.metricsCollector) {
        this.metricsCollector.recordConfigReloadFailure();
      }
      logger.error('ProviderConfigManager: reload failed, keeping previous config', {
        errors: result.errors,
      });
      return { success: false, errors: result.errors, warnings: result.warnings };
    }

    // 3. Run the reload cascade — reset all dependent subsystems so they
    //    pick up the new configuration.
    this._reloadCount += 1;
    this._runReloadCascade(result.providers);

    if (this.metricsCollector) {
      this.metricsCollector.recordConfigReload();
    }

    logger.info('ProviderConfigManager: reload successful', {
      providers: result.providers.length,
      enabled: result.providers.filter((p) => p.enabled).length,
    });

    return { success: true, errors: [], warnings: result.warnings };
  }

  /**
   * Run the reload cascade: reset the adapter cache, reload API keys,
   * invalidate the model registry cache, reset the health monitor, and
   * re-apply the routing strategy. Each step is independent — a failure
   * in one does not block the others.
   *
   * This is a public method so that the admin API can trigger the cascade
   * after a live provider edit without a full file-system reload.
   *
   * @param {Array<object>} providers - the new normalized provider list
   */
  reloadCascade(providers) { this._runReloadCascade(providers); }

  /**
   * Run the reload cascade: reset the adapter cache, reload API keys,
   * invalidate the model registry cache, reset the health monitor, and
   * re-apply the routing strategy. Each step is independent — a failure
   * in one does not block the others.
   *
   * @param {Array<object>} providers - the new normalized provider list
   * @private
   */
  _runReloadCascade(providers) {
    if (this.adapterRegistry && typeof this.adapterRegistry.reset === 'function') {
      try { this.adapterRegistry.reset(); } catch (e) {
        logger.warn('ProviderConfigManager: adapterRegistry.reset failed', { error: e && e.message });
      }
    }

    if (this.apiKeyManager && typeof this.apiKeyManager.load === 'function') {
      try { this.apiKeyManager.load(providers); } catch (e) {
        logger.warn('ProviderConfigManager: apiKeyManager.load failed', { error: e && e.message });
      }
    }

    if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
      try { this.modelRegistry.invalidate(); } catch (e) {
        logger.warn('ProviderConfigManager: modelRegistry.invalidate failed', { error: e && e.message });
      }
    }

    if (this.healthMonitor && typeof this.healthMonitor.reset === 'function') {
      try { this.healthMonitor.reset(); } catch (e) {
        logger.warn('ProviderConfigManager: healthMonitor.reset failed', { error: e && e.message });
      }
    }

    // Re-apply the routing strategy from the current config so a hot reload
    // of config/routing.json takes effect without a restart. The modelRouter
    // keeps its own strategy state; we refresh it here.
    if (this.modelRouter && this.routingConfig) {
      try {
        const strategy = this.routingConfig.strategy || 'priority';
        this.modelRouter.setStrategy(strategy);
      } catch (e) {
        logger.warn('ProviderConfigManager: modelRouter.setStrategy failed', { error: e && e.message });
      }
    }

    // Re-load aliases from disk so config/aliases.json changes take effect
    // without a restart.
    if (this.aliasResolver) {
      try {
        const { loadAliasesConfig } = require('../config/aliasesConfig');
        this.aliasResolver.load(loadAliasesConfig());
      } catch (e) {
        logger.warn('ProviderConfigManager: aliasResolver.load failed', { error: e && e.message });
      }
    }

    // Re-load routing rules from disk so config/routingRules.json changes
    // take effect without a restart.
    if (this.ruleEngine) {
      try {
        const { loadRoutingRulesConfig } = require('../config/routingRulesConfig');
        this.ruleEngine.load(loadRoutingRulesConfig().rules);
      } catch (e) {
        logger.warn('ProviderConfigManager: ruleEngine.load failed', { error: e && e.message });
      }
    }

    // Re-load virtual models from disk so config/virtualModels.json changes
    // take effect without a restart (Sprint 11). The model registry cache is
    // invalidated so the merged /v1/models catalog reflects the new VMs.
    if (this.virtualModelRegistry) {
      try {
        this.virtualModelRegistry.load(loadVirtualModelsConfig());
        if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
          this.modelRegistry.invalidate();
        }
      } catch (e) {
        logger.warn('ProviderConfigManager: virtualModelRegistry.load failed', { error: e && e.message });
      }
    }
  }

  /**
   * Reload ONLY the virtual models config from disk (validates first; on
   * failure keeps the previous loaded set). Used by the parent-dir file
   * watcher for config/virtualModels.json changes and by the admin API
   * "reload virtual models" action.
   *
   * @returns {{ success: boolean, errors: string[], warnings: string[], count: number }}
   */
  reloadVirtualModels() {
    if (!this.virtualModelRegistry) {
      return { success: false, errors: ['virtualModelRegistry not attached'], warnings: [], count: 0 };
    }
    const raw = loadVirtualModelsConfig();
    const { valid, errors, warnings, config } = validateVirtualModelsConfig(raw);
    if (!valid) {
      logger.warn('ProviderConfigManager: virtualModels hot-reload validation failed, keeping previous config', { errors });
      return { success: false, errors, warnings, count: 0 };
    }
    this.virtualModelRegistry.load(config);
    if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
      this.modelRegistry.invalidate();
    }
    logger.info('ProviderConfigManager: virtual models reloaded', {
      virtualModels: Object.keys(config.virtualModels).length,
    });
    return {
      success: true,
      errors: [],
      warnings,
      count: Object.keys(config.virtualModels).length,
    };
  }

  /**
   * Persist the full virtual-model set and reload (admin API "save virtual
   * models"). Validates BEFORE writing — on validation failure nothing is
   * written and the running config is left untouched.
   *
   * The `raw` argument is the new full config shape
   *   { virtualModels: { [id]: { enabled, strategy, candidates } } }
   * and completely replaces the on-disk config (this is intentional: the
   * admin dashboard sends the complete edited set, mirroring how the
   * provider config editor works).
   *
   * @param {object} raw
   * @returns {{ success: boolean, errors: string[], warnings: string[], count: number }}
   */
  saveVirtualModels(raw) {
    if (!this.virtualModelRegistry) {
      return { success: false, errors: ['virtualModelRegistry not attached'], warnings: [], count: 0 };
    }
    const result = saveVirtualModelsConfig(raw);
    if (!result.success) {
      return { success: false, errors: result.errors, warnings: result.warnings, count: 0 };
    }
    // On-disk config is now valid; swap the in-memory registry to match.
    this.virtualModelRegistry.load(result.config);
    if (this.modelRegistry && typeof this.modelRegistry.invalidate === 'function') {
      this.modelRegistry.invalidate();
    }
    return {
      success: true,
      errors: [],
      warnings: result.warnings,
      count: Object.keys(result.config.virtualModels).length,
    };
  }

  /**
   * Return reload statistics.
   * @returns {{ reloadCount: number, reloadFailures: number }}
   */
  getReloadStats() {
    return { reloadCount: this._reloadCount, reloadFailures: this._reloadFailures };
  }
}

module.exports = ProviderConfigManager;
