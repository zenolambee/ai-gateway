/**
 * PolicySimulator
 *
 * Dry-run evaluator that mirrors the runtime policy decision logic and
 * projects the outcome WITHOUT touching the live request path. Accepts a
 * sample request payload from the admin dashboard, constructs the same
 * facts object the live middleware would, runs the engine in audit mode,
 * and optionally projects `selectedProvider` / `selectedApiKey` /
 * `selectedVirtualModel` / `estimatedCost` from the available
 * provider/key/usage data so operators see the action the engine WOULD
 * take (not just the decision kind).
 *
 * Simulation history is bounded in-memory (last 200 runs by default) so
 * the admin UI can show "recent simulations" without persistence.
 *
 * Dependencies injected via constructor (composition root):
 *   - policyEngine     : PolicyEngine instance
 *   - providerManager  : for projecting which provider serves the body.model
 *   - virtualModelRegistry : for projecting the resolved VM candidates
 *   - pricingService   : for projecting estimated cost
 *   - apiKeyStore      : for projecting which gateway key matched
 *   - modelRouter      : optional, for projecting candidate ordering when
 *                        a non-force decision flows through normal routing
 */
class PolicySimulator {
  /**
   * @param {object} deps
   * @param {object} deps.policyEngine
   * @param {object} [deps.providerManager]
   * @param {object} [deps.virtualModelRegistry]
   * @param {object} [deps.pricingService]
   * @param {object} [deps.apiKeyStore]
   * @param {object} [deps.modelRouter]
   * @param {object} [opts]
   * @param {number} [opts.maxHistory=200]
   */
  constructor(deps = {}, opts = {}) {
    this.policyEngine = deps.policyEngine || null;
    this.providerManager = deps.providerManager || null;
    this.virtualModelRegistry = deps.virtualModelRegistry || null;
    this.pricingService = deps.pricingService || null;
    this.apiKeyStore = deps.apiKeyStore || null;
    this.modelRouter = deps.modelRouter || null;
    this.maxHistory = opts.maxHistory || 200;
    this.history = [];
    this.seq = 0;
  }

  /**
   * Run a simulation against a sample request and return a deterministic
   * projection of what the runtime WOULD do.
   *
   * @param {object} sample - { headers, body, apiKey (raw), requestId, method, path, now? }
   * @param {object} [opts]
   * @param {boolean} [opts.record] - persist into history (default true)
   * @returns {object}
   */
  simulate(sample = {}, opts = {}) {
    if (!this.policyEngine) return { ok: false, error: 'policy-engine-not-attached' };
    const record = opts.record !== false;
    const now = typeof sample.now === 'number' ? sample.now : Date.now();
    // Optional auth resolution: when the sample provides a raw API key,
    // validate it through the attached apiKeyStore (no-op when none attached
    // or when key absent — the request is treated as anonymous).
    let apiKey = null;
    if (sample.apiKey && this.apiKeyStore && typeof this.apiKeyStore.validate === 'function') {
      const res = this.apiKeyStore.validate(sample.apiKey);
      if (res && res.valid && res.key) apiKey = res.key;
    } else if (sample.apiKey && typeof sample.apiKey === 'object') {
      apiKey = sample.apiKey;
    }
    // Build a minimal "fake req" that buildFacts will accept.
    const fakeReq = {
      requestId: sample.requestId || 'sim',
      method: sample.method || 'POST',
      path: sample.path || '/v1/chat/completions',
      body: sample.body || {},
      headers: sample.headers || {},
      apiKey,
    };
    // If the sample 'request' provides an explicit operation hint, surface it.
    let operation = null;
    if (fakeReq.path && fakeReq.path.includes('/chat/')) operation = 'chat';
    else if (fakeReq.path && fakeReq.path.includes('/responses')) operation = 'responses';
    else if (fakeReq.path && fakeReq.path.includes('/embeddings')) operation = 'embeddings';
    else if (fakeReq.path && fakeReq.path.includes('/images')) operation = 'images';
    else if (fakeReq.path && fakeReq.path.includes('/audio')) operation = 'audio';
    else operation = sample.operation || null;

    // Build facts via the engine's exported helper to mirror runtime shape.
    const { buildFacts } = require('./policyEngine');
    const facts = buildFacts(fakeReq, {
      now,
      operation,
      estimatedTokens: sample.estimatedTokens || 0,
      estimatedCost: sample.estimatedCost || 0,
    });
    const evalRes = this.policyEngine.evaluate(facts, { audit: true });
    const decision = evalRes.decision;

    // Project the selected provider / api key / virtual model — these aren't
    // known pre-route so the simulator projects them from the static catalogue.
    let selectedProvider = null;
    let selectedApiKey = null;
    let selectedVirtualModel = null;
    let candidateProviders = [];
    const modelId = (decision.forceModel && decision.forceModel.modelId) || facts.request.model;

    if (decision.reject) { /* nothing selected */ }
    else {
      if (decision.forceProvider) selectedProvider = decision.forceProvider.providerId;
      else if (decision.selectProvider) selectedProvider = decision.selectProvider.providerId;
      if (decision.forceModel) selectedVirtualModel = null; // forces MODEL not VM
      else if (decision.selectVirtualModel) selectedVirtualModel = decision.selectVirtualModel.modelId;
      if (decision.selectApiKey) selectedApiKey = decision.selectApiKey.apiKeyId;

      // Project candidate providers (for the dashboard's "what would happen" view)
      if (modelId && this.providerManager) {
        try {
          const enabled = this.providerManager.getEnabledProviders();
          candidateProviders = enabled.filter((p) => Array.isArray(p.supportedModels) && p.supportedModels.includes(modelId)).map((p) => p.id);
          if (!selectedProvider && candidateProviders.length > 0) {
            selectedProvider = candidateProviders[0];
          }
        } catch (_) { /* ignore — keep projection null */ }
      } else if (modelId && this.virtualModelRegistry && this.virtualModelRegistry.isVirtualModel(modelId)) {
        try {
          const cands = this.virtualModelRegistry.resolveCandidates(modelId);
          candidateProviders = cands.map((p) => p.id);
          if (!selectedProvider && candidateProviders.length > 0) selectedProvider = candidateProviders[0];
          selectedVirtualModel = modelId;
        } catch (_) { /* ignore */ }
      }
    }

    // Project estimated cost (uses pricing service when available).
    let estimatedCost = 0;
    if (this.pricingService && this.pricingService.enabled) {
      try {
        estimatedCost = this.pricingService.calculateCost({
          model: modelId,
          operation,
          promptTokens: sample.inputTokens || sample.estimatedTokens || 0,
          completionTokens: sample.outputTokens || 0,
        });
      } catch (_) { estimatedCost = 0; }
    }

    // Project estimated routing decision (human-readable)
    let routingDecision;
    if (decision.reject) routingDecision = `reject (${decision.reject.reason})`;
    else if (decision.redirect) routingDecision = `redirect -> ${decision.redirect.url}`;
    else if (decision.requireApproval) routingDecision = `require-approval from ${decision.requireApproval.approver || 'admin'}`;
    else if (decision.forceProvider) routingDecision = `force provider=${decision.forceProvider.providerId}${decision.forceModel ? ` model=${decision.forceModel.modelId}` : ''}`;
    else if (decision.selectProvider) routingDecision = `prefer provider=${decision.selectProvider.providerId}`;
    else if (selectedProvider) routingDecision = `route to ${selectedProvider} (model=${modelId})`;
    else routingDecision = 'allow (default routing)';

    const out = {
      seq: this.seq,
      requestId: facts.request.requestId,
      simulatedAt: now,
      matchedPolicies: evalRes.matchedPolicies || [],
      ignoredPolicies: evalRes.ignoredPolicies || [],
      decision: {
        forceProvider: decision.forceProvider, forceModel: decision.forceModel,
        selectProvider: decision.selectProvider, selectApiKey: decision.selectApiKey, selectVirtualModel: decision.selectVirtualModel,
        redirect: decision.redirect, reject: decision.reject, requireApproval: decision.requireApproval,
        budgetLimit: decision.budgetLimit, rateLimitOverride: decision.rateLimitOverride, quotaOverride: decision.quotaOverride,
        reasons: decision.logReasons, rawActions: decision.rawActions,
      },
      projections: { selectedProvider, selectedApiKey, selectedVirtualModel, modelId, candidateProviders, estimatedCost, operation },
      routingDecision,
      facts: facts.request,
      audit: evalRes.audit,
    };
    if (record) {
      this.seq += 1;
      this.history.push({
        seq: this.seq,
        simulatedAt: now,
        requestId: facts.request.requestId,
        sample: { method: fakeReq.method, path: fakeReq.path, body: fakeReq.body, headers: fakeReq.headers, apiKeyId: apiKey && apiKey.id },
        routingDecision,
        matchedPolicies: out.matchedPolicies.map((p) => p.id),
        ignoredCount: (out.ignoredPolicies || []).length,
        selectedProvider,
        selectedApiKey,
        selectedVirtualModel,
        modelId,
        estimatedCost,
      });
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    return { ok: true, simulation: out };
  }

  /**
   * Replay a stored simulation by seq (admin "open recent run").
   * @param {number} seq
   * @returns {object|null}
   */
  getHistoryEntry(seq) { return this.history.find((h) => h.seq === seq) || null; }

  /**
   * List recent simulations (admin dashboard recent).
   * @param {number} limit
   * @returns {Array<object>}
   */
  listHistory(limit = 50) { return this.history.slice(-limit).reverse(); }

  reset() { this.history = []; this.seq = 0; }
}

module.exports = PolicySimulator;
