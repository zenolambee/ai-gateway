const logger = require('../utils/logger');
const routingStrategy = require('./routingStrategy');
const { validateVirtualModelsConfig } = require('../config/virtualModelsConfig');

/**
 * VirtualModelRegistry
 *
 * Defines virtual models — higher-level aliases that map a client-facing
 * model id (e.g. "coding-fast") to one or more { provider, model } candidate
 * tuples. When a client requests a virtual model, the gateway:
 *
 *   1. Resolves the alias to its candidate list (filtered to enabled
 *      candidates + enabled providers).
 *   2. Orders the candidates using the virtual model's selection strategy
 *      (priority, round-robin, lowest-latency, least-used, lowest-cost,
 *      highest-success-rate, weighted, random). The provider's health
 *      snapshot is provided to health-aware strategies.
 *   3. Hands the ordered list to the RequestExecutor, which iterates it
 *      with retry + fallback — exactly the same loop used for real
 *      models. Model-aware failover is enforced: a provider that does
 *      not appear in the candidate list for the virtual model is never
 *      routed.
 *
 * Each candidate carries the REAL model id the provider expects, so the
 * RequestExecutor's existing `_resolveModelForProvider` path transparently
 * swaps the client-sent virtual name for the per-provider canonical id.
 * Clients see the virtual model name; providers see the real model name.
 *
 * Backward compatibility: when a client sends a real model id (not
 * configured as a virtual model), the gateway falls back to the existing
 * ModelAliasResolver / ModelRouter path unchanged. Virtual models layer on
 * top of the existing routing infrastructure without modifying it.
 *
 * State is in-memory; reload is via `load()` (triggered by the
 * ProviderConfigManager hot-reload cascade when config/virtualModels.json
 * changes).
 */
class VirtualModelRegistry {
  /**
   * @param {object} deps
   * @param {object} [deps.providerManager] - to filter disabled providers
   * @param {object} [deps.healthMonitor] - for health-aware selection strategies
   * @param {object} [deps.apiKeyManager] - reserved for future per-key health
   */
  constructor({ providerManager, healthMonitor, apiKeyManager } = {}) {
    this.providerManager = providerManager || null;
    this.healthMonitor = healthMonitor || null;
    this.apiKeyManager = apiKeyManager || null;
    // id -> { enabled, strategy, candidates: [{provider, model, priority, weight, enabled}] }
    this.virtualModels = {};
    // reverse map: real model id -> [virtualId, ...] (for registry enrichment)
    this._reverse = new Map();
    // per-virtual-model round-robin cursors (used by round-robin strategy)
    this._cursors = {};
    this.loaded = false;
  }

  /**
   * Load (or reload) virtual model definitions from a config object (the
   * validated output of loadVirtualModelsConfig()). Invalid entries are
   * silently dropped after validation — call validateVirtualModelsConfig
   * first if you need the error list.
   *
   * @param {object} config - { virtualModels: { [id]: { enabled, strategy, candidates } } }
   * @returns {VirtualModelRegistry} this
   */
  load(config) {
    this.virtualModels = {};
    this._reverse = new Map();
    this._cursors = {};

    const vms = (config && config.virtualModels) || {};
    for (const [id, def] of Object.entries(vms)) {
      this._register(id, def);
    }
    this.loaded = true;
    logger.info('VirtualModelRegistry initialized', {
      virtualModels: Object.keys(this.virtualModels).length,
    });
    return this;
  }

  /**
   * Register a single virtual model. Replaces any existing entry with the
   * same id.
   * @private
   */
  _register(id, def) {
    if (!id || typeof id !== 'string') return;
    if (!def || !Array.isArray(def.candidates) || def.candidates.length === 0) return;

    const candidates = def.candidates
      .filter((c) => c && c.provider && c.model)
      .map((c) => ({
        provider: c.provider,
        model: c.model,
        priority: typeof c.priority === 'number' ? c.priority : 100,
        weight: typeof c.weight === 'number' && c.weight > 0 ? c.weight : 1,
        enabled: c.enabled !== undefined ? !!c.enabled : true,
      }));

    if (candidates.length === 0) return;

    this.virtualModels[id] = {
      enabled: def.enabled !== undefined ? !!def.enabled : true,
      strategy: def.strategy || 'priority',
      candidates,
    };

    for (const c of candidates) {
      if (!this._reverse.has(c.model)) this._reverse.set(c.model, []);
      if (!this._reverse.get(c.model).includes(id)) {
        this._reverse.get(c.model).push(id);
      }
    }
  }

  /**
   * Whether a given string is a configured (and enabled) virtual model id.
   *
   * @param {string} id
   * @returns {boolean}
   */
  isVirtualModel(id) {
    if (!id) return false;
    const vm = this.virtualModels[id];
    return !!(vm && vm.enabled && vm.candidates.some((c) => c.enabled));
  }

  /**
   * Return the raw definition for a virtual model id (admin API / introspection).
   * Returns null when the id is not configured.
   *
   * @param {string} id
   * @returns {object|null} a deep copy of the definition, or null
   */
  getVirtualModel(id) {
    const vm = this.virtualModels[id];
    if (!vm) return null;
    return {
      id,
      enabled: vm.enabled,
      strategy: vm.strategy,
      candidates: vm.candidates.map((c) => ({ ...c })),
    };
  }

  /**
   * Return all configured virtual models (admin API).
   * @returns {Array<object>}
   */
  listVirtualModels() {
    return Object.keys(this.virtualModels).map((id) => this.getVirtualModel(id));
  }

  /**
   * Create or replace a virtual model at runtime (admin API). Validates the
   * input via validateVirtualModelsConfig. Returns true on success, false
   * (with errors on the passed-in meta object) on failure.
   *
   * @param {string} id
   * @param {object} def - { enabled?, strategy?, candidates: [...] }
   * @param {object} [meta] - { errors?: string[], warnings?: string[] } (out)
   * @returns {boolean}
   */
  setVirtualModel(id, def, meta = {}) {
    if (!id || typeof id !== 'string') {
      meta.errors = ['virtual model id is required'];
      return false;
    }
    const { valid, errors, warnings, config } = validateVirtualModelsConfig({
      virtualModels: { [id]: def },
    });
    meta.errors = errors;
    meta.warnings = warnings;
    if (!valid || !config.virtualModels[id]) return false;
    this._register(id, config.virtualModels[id]);
    return true;
  }

  /**
   * Remove a virtual model. Returns true when something was removed.
   * @param {string} id
   * @returns {boolean}
   */
  removeVirtualModel(id) {
    const vm = this.virtualModels[id];
    if (!vm) return false;
    for (const c of vm.candidates) {
      const arr = this._reverse.get(c.model);
      if (arr) {
        const idx = arr.indexOf(id);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this._reverse.delete(c.model);
      }
    }
    delete this.virtualModels[id];
    delete this._cursors[id];
    return true;
  }

  /**
   * Enable or disable a virtual model at runtime (admin API).
   * @param {string} id
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setEnabled(id, enabled) {
    const vm = this.virtualModels[id];
    if (!vm) return false;
    vm.enabled = !!enabled;
    return true;
  }

  /**
   * Resolve a virtual model id to an ORDERED list of candidate provider
   * objects. The ordering follows the virtual model's selection strategy.
   * Disabled candidates and disabled providers are excluded. The returned
   * provider objects are the canonical ProviderManager entries (so the
   * RequestExecutor / HttpClient can use them unchanged).
   *
   * Each returned provider object is augmented with two virtual-model
   * fields for the executor:
   *   - __virtualModelId   : the client-facing virtual name (for metrics)
   *   - __virtualModelTarget : { model: <real model id> } the per-provider
   *                            real model id the executor should send
   *
   * @param {string} virtualId
   * @returns {Array<object>} ordered candidate providers (empty when the
   *   virtual model is unknown, disabled, or has no enabled candidate
   *   providers)
   */
  resolveCandidates(virtualId) {
    const vm = this.virtualModels[virtualId];
    if (!vm || !vm.enabled) return [];

    const enabledProviderIds = new Set(
      this.providerManager
        ? this.providerManager.getEnabledProviders().map((p) => p.id)
        : null
    );

    // Build candidate provider objects. Each candidate carries its real
    // model id (so the executor can override input.model per provider).
    const candidates = [];
    for (const c of vm.candidates) {
      if (!c.enabled) continue;
      if (enabledProviderIds.size > 0 && !enabledProviderIds.has(c.provider)) continue;
      const provider = this.providerManager && this.providerManager.providersById
        ? this.providerManager.providersById.get(c.provider)
        : null;
      if (!provider) continue;

      // Augment a shallow copy with the virtual-model per-provider target.
      // The executor reads __virtualModelTarget.model to override input.model
      // for this provider; __virtualModelId is used for metrics.
      candidates.push({
        ...provider,
        priority: c.priority, // virtual-model candidate priority overrides provider priority
        weight: c.weight, // virtual-model candidate weight overrides provider weight
        __virtualModelId: virtualId,
        __virtualModelTarget: { model: c.model },
      });
    }

    if (candidates.length <= 1) return candidates;

    // Apply the selection strategy. Health-aware strategies need the
    // current health snapshot; round-robin needs the per-virtual cursor.
    const ctx = {
      model: virtualId,
      health: this.healthMonitor ? this.healthMonitor.getAllHealth() : {},
      cursors: this._cursors,
      opts: {},
    };
    let ordered;
    try {
      ordered = routingStrategy.applyStrategy(vm.strategy, candidates, ctx);
    } catch (err) {
      logger.warn('Virtual model: strategy failed, falling back to priority order', {
        virtualId: virtualId, strategy: vm.strategy, error: err && err.message,
      });
      ordered = routingStrategy.priorityStrategy([...candidates]);
    }
    return Array.isArray(ordered) ? ordered : [...candidates];
  }

  /**
   * Resolve the list of canonical (real) model ids that a virtual model
   * maps to — exposing the same shape as ModelAliasResolver.resolve() so
   * the existing RequestExecutor / ModelRouter paths can consume it
   * unchanged. Returns the input as a single-element array when the id is
   * not a virtual model (backward-compatible fallthrough).
   *
   * @param {string} virtualId
   * @returns {string[]} real model ids (length >= 1; [virtualId] when not a virtual model)
   */
  resolve(virtualId) {
    if (!virtualId || typeof virtualId !== 'string') return [];
    const vm = this.virtualModels[virtualId];
    if (!vm || !vm.enabled) return [virtualId];
    // Return the real model ids (deduplicated). The first is the
    // highest-priority candidate's real model — used by ModelRouter when
    // it needs a single canonical id (e.g. for capability checks).
    const ids = [];
    const seen = new Set();
    for (const c of vm.candidates) {
      if (!c.enabled) continue;
      if (!seen.has(c.model)) { seen.add(c.model); ids.push(c.model); }
    }
    return ids.length > 0 ? ids : [virtualId];
  }

  /**
   * Return the virtual models that map to a given real model id (for the
   * admin / models registry enrichment).
   * @param {string} realModelId
   * @returns {string[]}
   */
  virtualModelsForRealModel(realModelId) {
    return this._reverse.get(realModelId) || [];
  }
}

module.exports = VirtualModelRegistry;
