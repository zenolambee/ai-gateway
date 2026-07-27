const AppError = require('../utils/AppError');
const routingStrategy = require('./routingStrategy');

/**
 * ModelRouter
 *
 * Responsible for selecting which provider should serve a given model.
 * It delegates provider lookup to the ProviderManager and applies routing
 * policies via the pluggable RoutingStrategy. Keeping this logic in a
 * dedicated service means the Chat Completions layer does not depend directly
 * on ProviderManager internals, and routing policy can evolve independently.
 *
 * The router is model-aware: it only returns providers whose
 * `supportedModels` array contains the requested model. This enforces the
 * model-aware failover contract — the RequestExecutor's fallback chain can
 * only ever visit providers that serve the SAME model the client requested.
 * The gateway never silently substitutes one model for another.
 */
class ModelRouter {
  /**
   * @param {object} providerManager - ProviderManager instance
   * @param {object} [opts]
   * @param {string} [opts.defaultStrategy='priority'] - default routing strategy
   * @param {object} [opts.healthMonitor] - for health-aware strategies
   * @param {object} [opts.virtualModelRegistry] - for virtual model resolution
   * @param {object} [opts.usageTracker] - reserved for future use
   */
  constructor(providerManager, opts = {}) {
    if (!providerManager) {
      throw new Error('ModelRouter requires a ProviderManager instance');
    }
    this.providerManager = providerManager;
    this.defaultStrategy = opts.defaultStrategy || 'priority';
    this.healthMonitor = opts.healthMonitor || null;
    this.aliasResolver = opts.aliasResolver || null;
    this.ruleEngine = opts.ruleEngine || null;
    this.virtualModelRegistry = opts.virtualModelRegistry || null;
    // Per-model routing overrides: { [modelId]: { strategy, providerOrder } }
    this._modelOverrides = {};
    this.strategy = this.defaultStrategy;
    // Per-model round-robin cursors (used by the round-robin routing strategy)
    this._cursors = {};
  }

  /**
   * Set per-model routing overrides (admin API / hot reload).
   * @param {object} overrides - { [modelId]: { strategy?: string, providerOrder?: string[] } }
   */
  setModelOverrides(overrides) {
    this._modelOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  }

  /**
   * Get per-model routing overrides (for admin API).
   * @returns {object}
   */
  getModelOverrides() {
    return { ...this._modelOverrides };
  }

  /**
   * Set the active routing strategy at runtime (admin API / hot reload).
   * @param {string} strategyId
   */
  setStrategy(strategyId) {
    this.strategy = strategyId || this.defaultStrategy;
  }

  /**
   * Get the active routing strategy id.
   * @returns {string}
   */
  getStrategy() {
    return this.strategy;
  }

  /**
   * Find the best enabled provider for a given model identifier.
   *
   * Routing policy:
   *   1. Only providers that are `enabled` are considered.
   *   2. Only providers whose `supportedModels` includes the model are
   *      considered (model-aware routing — no silent model substitution).
   *   3. The configured routing strategy orders the candidates.
   *   4. If no provider supports the model, throws 404 model_not_found.
   *   5. If providers exist for the model but all are disabled, throws 503.
   *
   * @param {string} model - model identifier (e.g. "gpt-4o")
   * @returns {object} selected provider config
   */
  routeToProvider(model) {
    if (!model || typeof model !== 'string') {
      throw new AppError(
        "you must provide a model parameter",
        400,
        { code: 'INVALID_REQUEST' }
      );
    }

    return this.providerManager.getProviderByModel(model);
  }

  /**
   * Return all enabled providers that can serve the given model, ordered by
   * the configured routing strategy. Useful for fallback / retry features.
   *
   * The list is ALWAYS restricted to providers that support the requested
   * model — the model-aware failover contract. The RequestExecutor
   * iterates this list on failure; it can never fall back to a provider
   * that serves a different model.
   *
   * When an alias resolver is attached, the `model` argument is first
   * resolved to one or more canonical model ids. Candidates from ALL
   * canonical models are merged (with deduplication) so the gateway can
   * fail over across backing models when one is unavailable — while the
   * client only ever sees the alias it sent.
   *
   * When a VirtualModelRegistry is attached and the requested id is a
   * configured (enabled) virtual model, the registry returns an ordered
   * candidate list of provider objects already augmented with each provider's
   * real model id (via __virtualModelTarget). Virtual models take
   * precedence over plain aliases because they carry richer routing
   * information (per-candidate priority/weight/strategy).
   *
   * When a routing rule engine is attached, the rules are applied AFTER
   * the strategy ordering to skip/prefer/demote candidates based on
   * health, latency, cooldown, and success rate.
   *
   * Per-model routing overrides (from `setModelOverrides`) take
   * precedence over the global strategy and can specify an explicit
   * provider order for a given model.
   *
   * @param {string} model - model identifier or alias (e.g. "gpt-5")
   * @returns {Array<object>}
   */
  getCandidateProviders(model) {
    if (!model || typeof model !== 'string') {
      return [];
    }

    // 0. Virtual model fast path: if the requested id is a configured
    //    virtual model, ask the registry for the ordered candidates.
    //    Each candidate carries __virtualModelTarget.model = the real
    //    model id the executor should send to that provider.
    if (this.virtualModelRegistry && this.virtualModelRegistry.isVirtualModel(model)) {
      return this.virtualModelRegistry.resolveCandidates(model);
    }

    // 1. Resolve alias to canonical model ids (returns [model] when not an alias).
    const modelIds = this.aliasResolver ? this.aliasResolver.resolve(model) : [model];

    // 2. Collect candidates from ALL canonical models (union, deduplicated by provider id).
    const enabled = this.providerManager.getEnabledProviders();
    const seenIds = new Set();
    let candidates = [];
    for (const mid of modelIds) {
      for (const p of enabled) {
        if (Array.isArray(p.supportedModels) && p.supportedModels.includes(mid) && !seenIds.has(p.id)) {
          seenIds.add(p.id);
          candidates.push(p);
        }
      }
    }

    if (candidates.length === 0) return candidates;

    // 3. Apply per-model override (explicit provider order) when configured.
    const override = this._modelOverrides[model];
    if (override && Array.isArray(override.providerOrder) && override.providerOrder.length > 0) {
      const order = override.providerOrder;
      candidates.sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    } else {
      // 4. Apply the routing strategy. Health-aware strategies need the
      //    current health snapshot; round-robin needs the per-model cursor map.
      const strategyId = (override && override.strategy) || this.strategy;
      const ctx = {
        model,
        health: this.healthMonitor ? this.healthMonitor.getAllHealth() : {},
        cursors: this._cursors,
        opts: {},
      };
      candidates = routingStrategy.applyStrategy(strategyId, candidates, ctx);
    }

    // 5. Apply routing rules (skip/prefer/demote based on health, latency, cooldown).
    if (this.ruleEngine && this.ruleEngine.rules.length > 0) {
      const keyHealth = {};
      if (this.apiKeyManager && typeof this.apiKeyManager.getAllKeyHealth === 'function') {
        const allHealth = this.apiKeyManager.getAllKeyHealth();
        for (const [pid, keys] of Object.entries(allHealth)) {
          keyHealth[pid] = keys;
        }
      }
      candidates = this.ruleEngine.applyRules(candidates, {
        health: this.healthMonitor ? this.healthMonitor.getAllHealth() : {},
        keyHealth,
      });
    }

    return candidates;
  }

  /**
   * Resolve the canonical model id(s) for a client-sent alias or model.
   * Exposed for the RequestExecutor so it can send the real model id to
   * the provider (providers don't know about aliases or virtual models).
   *
   * When a VirtualModelRegistry is attached and the id is a configured
   * virtual model, returns the list of real model ids the virtual model
   * maps to (so the executor's per-provider resolution can pick the one
   * the selected provider actually serves).
   *
   * @param {string} aliasOrModel
   * @returns {string[]} canonical model ids (length >= 1)
   */
  resolveModel(aliasOrModel) {
    if (this.virtualModelRegistry && this.virtualModelRegistry.isVirtualModel(aliasOrModel)) {
      return this.virtualModelRegistry.resolve(aliasOrModel);
    }
    if (this.aliasResolver) return this.aliasResolver.resolve(aliasOrModel);
    return [aliasOrModel];
  }

  /**
   * Inject the API key manager (for rule engine key-health lookups).
   * Done via late binding by the composition root.
   * @param {object} mgr
   */
  setApiKeyManager(mgr) { this.apiKeyManager = mgr; }
}

module.exports = ModelRouter;
