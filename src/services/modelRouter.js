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
    // Model-based routing rules (Dashboard-managed): ruleId -> rule object.
    // Rules are also folded into _modelOverrides for the strategy/provider
    // ordering; the full rule records live here for the admin API.
    this._modelRules = new Map();
    this.strategy = this.defaultStrategy;
    // Per-model round-robin cursors (used by the round-robin routing strategy)
    this._cursors = {};
    // SDK routing bridge (late-bound) for capability-aware SDK providers.
    this.sdkRoutingBridge = null;
    // Capability store for legacy providers: providerId -> capability object.
    // Populated by discovery/health so capability routing works for legacy too.
    this._legacyCapabilities = {};
    // Late-bound ConnectionManager (composition root) — used by model rules
    // to restrict the eligible connection set per model.
    this.connectionManager = null;
    // Keep direct (non-rule) overrides separate so rules can overlay them.
    this._directModelOverrides = {};
  }

  /**
   * Set the effective capability map for providers. The object maps
   * providerId -> capability flags { chat, responses, embeddings, images,
   * audio, tools, vision, streaming, ... }. Used by capability-aware routing.
   * @param {object} caps
   */
  setCapabilityMap(caps) {
    if (caps && typeof caps === 'object') this._legacyCapabilities = caps;
  }

  /**
   * Return the capability object for a provider, resolving from the SDK
   * manifest first, then the legacy capability map.
   * @param {object} provider
   * @returns {object|null}
   * @private
   */
  _providerCapabilities(provider) {
    if (this.sdkRoutingBridge && typeof this.sdkRoutingBridge.capabilities === 'function') {
      const c = this.sdkRoutingBridge.capabilities(provider);
      if (c) return c;
    }
    const p = this._legacyCapabilities[provider.id];
    if (p) return p;
    return null;
  }

  /**
   * Whether a provider supports a required capability. Unknown providers
   * (no manifest, no map, no capability gate) are considered capable so
   * capability-less deployments keep full backward compatibility.
   * @param {object} provider
   * @param {string} capability
   * @returns {boolean}
   * @private
   */
  _supports(provider, capability) {
    const caps = this._providerCapabilities(provider);
    if (!caps) return true; // unknown => allow (backward compatible)
    const val = caps[capability];
    // If the capability is not tracked for this provider, allow it.
    if (val === undefined) return true;
    return !!val;
  }


  /**
   * Set per-model routing overrides (admin API / hot reload).
   * @param {object} overrides - { [modelId]: { strategy?: string, providerOrder?: string[] } }
   */
  setModelOverrides(overrides) {
    this._directModelOverrides = overrides && typeof overrides === 'object' ? overrides : {};
    // Keep any active model rules on top of the direct overrides.
    this._syncModelRuleOverrides();
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
   * @param {object} [options] - optional { capabilities: string[] }
   * @returns {object} selected provider config
   */
  routeToProvider(model, options = {}) {
    if (!model || typeof model !== 'string') {
      throw new AppError(
        "you must provide a model parameter",
        400,
        { code: 'INVALID_REQUEST' }
      );
    }

    // When capability routing is requested, use the capability-aware candidate
    // path and pick the first. Otherwise preserve the original fast path.
    if (Array.isArray(options.capabilities) && options.capabilities.length > 0) {
      const candidates = this.getCandidateProviders(model, { capabilities: options.capabilities });
      if (candidates.length === 0) {
        // No candidate supports the model with the required capabilities.
        if (!this.providerManager.getProviderByModel) {
          throw new AppError(`No provider supports model "${model}"`, 404, { code: 'MODEL_NOT_FOUND' });
        }
        // Determine whether the model exists at all vs. just lacks capability.
        try {
          this.providerManager.getProviderByModel(model); // throws if no model
          // Model exists but no candidate meets the capability gate.
          return this.providerManager.getProviderByModel(model);
        } catch (err) {
          throw err;
        }
      }
      return candidates[0];
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
   * @param {object} [options]
   * @param {string[]} [options.capabilities] - required capabilities; when
   *   provided, only candidates that (per SDK manifest or legacy capability
   *   map) support ALL of them are considered. Unknown/lack of capability
   *   data is treated as "capable" to preserve backward compatibility.
   * @returns {Array<object>}
   */
  getCandidateProviders(model, options = {}) {
    if (!model || typeof model !== 'string') {
      return [];
    }
    const required = Array.isArray(options.capabilities) ? options.capabilities : [];

    // 0. Virtual model fast path: if the requested id is a configured
    //    virtual model, ask the registry for the ordered candidates.
    //    Each candidate carries __virtualModelTarget.model = the real
    //    model id the executor should send to that provider.
    if (this.virtualModelRegistry && this.virtualModelRegistry.isVirtualModel(model)) {
      return this.virtualModelRegistry.resolveCandidates(model);
    }

    // 0b. Capability-award filter for virtual models: when required
    //     capabilities are requested and the resolved candidates exist,
    //     filter them. Virtual registry returns candidates already ordered.
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

    // 2b. Capability-aware filter (when required capabilities are given).
    if (required.length > 0) {
      candidates = candidates.filter((p) => required.every((cap) => this._supports(p, cap)));
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

  // ---------------------------------------------------------------
  // Model-based routing rules (Dashboard-managed)
  //
  // A model rule binds a model id to a routing strategy, an optional
  // explicit provider order, and an optional connection allow-list. Rules
  // are translated into the existing per-model override mechanism — no
  // separate router. Connection allow-lists are surfaced to the
  // RequestExecutor via `_connectionAllowList(model)` and enforced when
  // the ConnectionManager resolves the runtime credential.
  // ---------------------------------------------------------------

  /**
   * Replace the full model-rule set (id -> rule). Each rule:
   *   { id, model, strategy?, providerOrder?, connectionIds?, enabled? }
   * Disabled rules are dropped from the active overrides.
   * @param {Array<object>} rules
   */
  setModelRules(rules) {
    this._modelRules = new Map();
    const list = Array.isArray(rules) ? rules : [];
    for (const r of list) {
      if (r && typeof r.id === 'string' && r.id && typeof r.model === 'string' && r.model) {
        this._modelRules.set(r.id, {
          id: r.id,
          model: r.model,
          strategy: typeof r.strategy === 'string' ? r.strategy : undefined,
          providerOrder: Array.isArray(r.providerOrder) ? [...r.providerOrder] : undefined,
          connectionIds: Array.isArray(r.connectionIds) ? [...r.connectionIds] : undefined,
          enabled: r.enabled !== false,
        });
      }
    }
    this._syncModelRuleOverrides();
  }

  /**
   * Add or update a single model rule.
   * @param {object} rule
   */
  setModelRule(rule) {
    if (!rule || typeof rule.id !== 'string' || !rule.id) return false;
    if (typeof rule.model !== 'string' || !rule.model) return false;
    this._modelRules.set(rule.id, {
      id: rule.id,
      model: rule.model,
      strategy: typeof rule.strategy === 'string' ? rule.strategy : undefined,
      providerOrder: Array.isArray(rule.providerOrder) ? [...rule.providerOrder] : undefined,
      connectionIds: Array.isArray(rule.connectionIds) ? [...rule.connectionIds] : undefined,
      enabled: rule.enabled !== false,
    });
    this._syncModelRuleOverrides();
    return true;
  }

  /**
   * Remove a model rule by id.
   * @param {string} id
   * @returns {boolean}
   */
  removeModelRule(id) {
    const ok = this._modelRules.delete(id);
    if (ok) this._syncModelRuleOverrides();
    return ok;
  }

  /**
   * Return all model rules (for the admin API).
   * @returns {Array<object>}
   */
  listModelRules() {
    return [...this._modelRules.values()].map((r) => ({ ...r }));
  }

  /**
   * Return the connection allow-list for a model (union of all enabled
   * rules targeting the model that declare a connectionIds list), or null
   * when no rule restricts connections.
   * @param {string} model
   * @returns {string[]|null}
   */
  connectionAllowList(model) {
    if (!model) return null;
    const allowed = new Set();
    let restricted = false;
    for (const r of this._modelRules.values()) {
      if (r.enabled === false || r.model !== model) continue;
      if (Array.isArray(r.connectionIds)) {
        restricted = true;
        for (const c of r.connectionIds) allowed.add(c);
      }
    }
    return restricted ? [...allowed] : null;
  }

  /**
   * Fold the enabled model rules into the per-model override map consumed
   * by getCandidateProviders(). Rules take precedence over any overrides
   * set directly via setModelOverrides for the same model — but direct
   * overrides for models without rules are preserved.
   * @private
   */
  _syncModelRuleOverrides() {
    // Start from the direct overrides (setModelOverrides) and overlay rules.
    const base = this._directModelOverrides || {};
    const merged = { ...base };
    for (const r of this._modelRules.values()) {
      if (r.enabled === false) continue;
      const entry = {};
      if (r.strategy) entry.strategy = r.strategy;
      if (Array.isArray(r.providerOrder) && r.providerOrder.length > 0) entry.providerOrder = [...r.providerOrder];
      if (Object.keys(entry).length > 0) merged[r.model] = entry;
    }
    this._modelOverrides = merged;
  }
}

module.exports = ModelRouter;
