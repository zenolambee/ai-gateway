const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { loadProviders } = require('../config/providersConfig');

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
  } = {}, opts = {}) {
    this.providerManager = providerManager;
    this.adapterRegistry = adapterRegistry || null;
    this.apiKeyManager = apiKeyManager || null;
    this.modelRegistry = modelRegistry || null;
    this.healthMonitor = healthMonitor || null;
    this.metricsCollector = metricsCollector || null;

    this.debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 100;
    this._watcher = null;
    this._debounceTimer = null;
    this._reloadCount = 0;
    this._reloadFailures = 0;
  }

  /**
   * Start watching the provider config directory for changes.
   */
  startWatching() {
    const dir = this.providerManager._configDir
      || process.env.PROVIDERS_CONFIG_DIR
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
  }

  /**
   * Stop watching the config directory.
   */
  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
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
    const dir = this.providerManager._configDir
      || process.env.PROVIDERS_CONFIG_DIR
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
   * invalidate the model registry cache, and reset the health monitor.
   * Each step is independent — a failure in one does not block the others.
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
