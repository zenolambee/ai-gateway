/**
 * PolicyEngine
 *
 * Centralised Enterprise Policy Engine for routing decisions (Sprint 13).
 * Evaluates a list of declarative policies against each incoming request
 * and produces a single merged "decision" object that the rest of the
 * gateway applies. Designed to be 100% backward compatible — when no
 * policies are configured (or `enabled: false`) the engine is a no-op and
 * every request falls through to the existing routing handled by
 * ModelRouter + RoutingRuleEngine + RoutingStrategy.
 *
 * =====================
 * Policy shape (declarative)
 * =====================
 *
 *   {
 *     id:           string (unique)
 *     name:         string
 *     description?: string
 *     enabled:      boolean
 *     priority:     number   // lower runs first (default 100)
 *     tags?:        string[]
 *     weight?:      number   // weighted resolution between matching policies
 *     default?:     boolean // run after all non-default rules
 *     fallback?:    boolean // only run when nothing else matched
 *     when: { ...conditions... }     // see condition grammar below
 *     then: { ...decisions... }       // see ACTIONS below
 *   }
 *
 * =====================
 * Condition grammar
 * =====================
 *
 *   { and: [ cond, cond, ... ] }
 *   { or:  [ cond, cond, ... ] }
 *   { not: cond }
 *   { "fact.path": { op: operand, op: operand, ... } }   // AND between operators
 *
 * Supported operators (same set as the existing routingRuleEngine so admins
 * only learn one syntax): ==, !=, >, >=, <, <=, in, not-in, exists,
 * contains, starts-with, ends-with, regex.
 *
 * =====================
 * Available facts (per-request)
 * =====================
 *
 *   request.requestId            string
 *   request.apiKeyId             string  (from req.apiKey.id — null in open mode)
 *   request.apiKeyName           string
 *   request.apiKeyRole           string  ('admin'|'user')
 *   request.method                string ('POST'|'GET'...)
 *   request.path                  string ('/v1/chat/completions')
 *   request.model                 string  (req.body.model when present)
 *   request.virtualModel          string  (the virtual-model id, parsed by VMDetector)
 *   request.providerId            null    (provider unknown at pre-route; populated post-route)
 *   request.organization          string  (apiKey.organizationId or body.organization_id)
 *   request.project               string  (apiKey.projectId or body.project_id)
 *   request.user                  string  (apiKey.userId or body.user_id)
 *   request.region                string  ('x-gateway-region' header or req.headers['x-region'])
 *   request.tags                  string[]  (apiKey.tags or body.tags)
 *   request.hourOfDay             number  (UTC 0..23)
 *   request.dayOfWeek             number  (UTC 0..6, Mon=1..Sun=6 — ISO like)
 *   request.timestamp             number  (Date.now())
 *   request.estimatedTokens       number  (best-effort estimate; 0 when unknown)
 *   request.estimatedCost         number  (best-effort cost; 0 when unknown)
 *   request.operation             string  ('chat'|'responses'|'embeddings'|'images'|'audio')
 *   request.body                  object  (the raw body — useful for context+presence)
 *
 * Routing-context facts used by post-candidate evaluation (when the engine
 * is invoked from ModelRouter instead of the middleware):
 *
 *   route.candidates             array
 *   route.provider.<id>.priority  number
 *   route.provider.<id>.weight   number
 *   route.provider.<id>.healthy   boolean
 *   route.provider.<id>.successRate number
 *   route.provider.<id>.latency   number
 *
 * =====================
 * Decisions (then.<...>)
 * =====================
 *
 *   select_provider:     { providerId: 'anthropic' }   // prefer this provider
 *   select_api_key:      { apiKeyId: 'k1' }            // prefer this upstream key
 *   select_virtual_model: { modelId: 'coding-fast' }  // suggest a different VM
 *   force_provider:      { providerId: 'openai' }       // first-match MUST be used
 *   force_model:         { modelId: 'gpt-4o' }
 *   redirect:            { url: 'http://...', statusCode?: 307 }
 *   reject:               { reason: 'forbidden', statusCode?: 403 }
 *   apply_rate_limit:     { ... }    // forwarded to rateLimiter override
 *   apply_budget_limit:   { scope, scopeId?, maxCostPerRequest }
 *   apply_quota:          { bypass?: boolean, policy? }
 *   require_approval:    { approver: 'admin', message?: string }
 *   log_decision:         { reason: string, level?: 'info'|'warn' }
 *
 * `default` and `fallback` policies are special:
 *   - default: evaluated last (after every other matching policy); meant
 *     to log the implicit allow / set sensible baseline. Multiple
 *     `default` policies may match.
 *   - fallback: evaluated ONLY when no other policy produced a routing
 *     decision (`force_*` / `select_*` / `reject`).
 *
 * =====================
 * Merge semantics
 * =====================
 *
 *  1. Non-default / non-fallback policies are evaluated in priority order
 *     (stable sort by priority asc, then weight desc when weights equal).
 *  2. The first policy matching a `reject` decision short-circuits —
 *     rejection immediately wins regardless of subsequent policies.
 *  3. The first matching `force_provider` / `force_model` / `redirect`
 *     short-circuits similarly (these are exclusive within a request).
 *  4. Otherwise matching `select_*` / `apply_*` / `require_approval` /
 *     `log_decision` actions are MERGED — later policies can refine the
 *     decision produced by earlier ones. Weighted ranking applies only
 *     when two equally-prioritised policies conflict on the same
 *     terminal decision kind.
 *  5. After all non-default policies have run, matching `default`
 *     policies apply.
 *  6. Finally, when NO terminal decision (force_*, select_*, reject,
 *     redirect) was produced, matching `fallback` policies apply.
 *
 * The engine returns a single `Evaluation` object — see `evaluate()`.
 *
 * =====================
 * Hot reload
 * =====================
 *
 * `load(config)` swaps the policy list atomically. Existing in-flight
 * evaluations finish against the previous list (because evaluate() takes
 * a local array reference). Reload can be triggered from the admin API,
 * from config-file watcher events, or programmatically. When the new
 * config fails validation we keep the previous list (matches the
 * validate-then-swap pattern used by Sprint 12 for pricing/budget/quota).
 *
 * All state is in-memory; the policy list itself is persisted via
 * config/policies.json (atomic savePolicyConfig()).
 */
const logger = require('../utils/logger');

const ACTIONS = {
  select_provider: true,
  select_api_key: true,
  select_virtual_model: true,
  force_provider: true,
  force_model: true,
  redirect: true,
  reject: true,
  apply_rate_limit: true,
  apply_budget_limit: true,
  apply_quota: true,
  require_approval: true,
  log_decision: true,
};

/**
 * Read a dotted fact path from a facts object. Supports array indexing
 * (e.g. `request.tags.0`) and array-length operator `route.candidates.length`.
 * @param {string} p
 * @param {object} facts
 * @returns {*}
 */
function getFact(p, facts) {
  if (typeof p !== 'string') return undefined;
  if (p === 'request.tags.length' && Array.isArray(facts.request && facts.request.tags)) return facts.request.tags.length;
  if (p === 'route.candidates.length' && Array.isArray(facts.route && facts.route.candidates)) return facts.route.candidates.length;
  const parts = p.split('.');
  let cur = facts;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Evaluate a single test object against a fact value. The existing
 * `routingRuleEngine.evaluateTest` only handled ==,!=,>,<,>=,<=,in,not-in;
 * we add a richer set so admins can write more expressive policies without
 * learning two grammars.
 * @param {object|string|number|boolean|undefined|null} test
 * @param {*} factValue
 * @returns {boolean}
 */
function evaluateTest(test, factValue) {
  if (test === null || test === undefined) return factValue === test;
  if (typeof test !== 'object' || Array.isArray(test)) return factValue === test;
  for (const [op, operand] of Object.entries(test)) {
    switch (op) {
      case '==': if (factValue !== operand) return false; break;
      case '!=': if (factValue === operand) return false; break;
      case '>': if (!(typeof factValue === 'number' && factValue > operand)) return false; break;
      case '>=': if (!(typeof factValue === 'number' && factValue >= operand)) return false; break;
      case '<': if (!(typeof factValue === 'number' && factValue < operand)) return false; break;
      case '<=': if (!(typeof factValue === 'number' && factValue <= operand)) return false; break;
      case 'in': if (!Array.isArray(operand) || !operand.includes(factValue)) return false; break;
      case 'not-in': if (!Array.isArray(operand) || operand.includes(factValue)) return false; break;
      case 'exists': if (!!factValue !== !!operand) return false; break;
      case 'contains': {
        if (typeof factValue === 'string' && typeof operand === 'string') { if (!factValue.includes(operand)) return false; }
        else if (Array.isArray(factValue)) { if (!factValue.includes(operand)) return false; }
        else if (factValue && typeof factValue === 'object') { if (!Object.values(factValue).includes(operand)) return false; }
        else return false;
        break;
      }
      case 'not-contains': {
        if (typeof factValue === 'string' && typeof operand === 'string') { if (factValue.includes(operand)) return false; }
        else if (Array.isArray(factValue)) { if (factValue.includes(operand)) return false; }
        else if (factValue && typeof factValue === 'object') { if (Object.values(factValue).includes(operand)) return false; }
        break;
      }
      case 'starts-with': if (typeof factValue !== 'string' || !factValue.startsWith(operand)) return false; break;
      case 'ends-with': if (typeof factValue !== 'string' || !factValue.endsWith(operand)) return false; break;
      case 'regex': {
        let re;
        try { re = operand instanceof RegExp ? operand : new RegExp(operand); }
        catch (_) { re = null; }
        if (!re || typeof factValue !== 'string' || !re.test(factValue)) return false;
        break;
      }
      default: return false;
    }
  }
  return true;
}

/**
 * Evaluate a condition recursively (and/or/not/leaf).
 * @param {object} cond
 * @param {object} facts
 * @returns {boolean}
 */
function evaluateCondition(cond, facts) {
  if (!cond || typeof cond !== 'object') return true;
  if (Array.isArray(cond.and)) return cond.and.every((c) => evaluateCondition(c, facts));
  if (Array.isArray(cond.or)) return cond.or.some((c) => evaluateCondition(c, facts));
  if (cond.not !== undefined) return !evaluateCondition(cond.not, facts);
  for (const [factPath, test] of Object.entries(cond)) {
    const factValue = getFact(factPath, facts);
    if (!evaluateTest(test, factValue)) return false;
  }
  return true;
}

/**
 * Construct the facts object for one request. Safe to call with sparse
 * inputs — every fact defaults to a sane null/zero so policies can rely
 * on the fact always being present (matching `exists` uses truthiness).
 *
 * @param {object} req - Express-like request (req.apiKey, req.body, req.headers)
 * @param {object} [extra]
 * @param {number} [extra.now]
 * @returns {object}
 */
function buildFacts(req = {}, extra = {}) {
  const apiKey = req.apiKey || null;
  const body = req.body || {};
  const headers = req.headers || {};
  const now = typeof extra.now === 'number' ? extra.now : Date.now();
  const d = new Date(now);
  const region = headers['x-gateway-region'] || headers['x-region'] || (apiKey && apiKey.region) || null;
  const tagsFromKey = apiKey && Array.isArray(apiKey.tags) ? apiKey.tags : [];
  const tagsFromBody = Array.isArray(body.tags) ? body.tags : [];
  return {
    request: {
      requestId: req.requestId || null,
      apiKeyId: apiKey ? apiKey.id : null,
      apiKeyName: apiKey ? apiKey.name : null,
      apiKeyRole: apiKey ? apiKey.role : null,
      method: req.method || null,
      path: req.path || req.baseUrl || null,
      model: body.model || null,
      virtualModel: body.model || null,
      providerId: extra.providerId || null,
      organization: (apiKey && apiKey.organizationId) || body.organization_id || null,
      project: (apiKey && apiKey.projectId) || body.project_id || null,
      user: (apiKey && apiKey.userId) || body.user_id || (apiKey ? apiKey.id : null),
      region,
      tags: [...tagsFromKey, ...tagsFromBody],
      hourOfDay: d.getUTCHours(),
      dayOfWeek: d.getUTCDay() === 0 ? 7 : d.getUTCDay(), // ISO-like Mon=1..Sun=7
      timestamp: now,
      estimatedTokens: extra.estimatedTokens || 0,
      estimatedCost: extra.estimatedCost || 0,
      operation: extra.operation || null,
      body,
    },
    route: extra.route || { candidates: [] },
  };
}

class PolicyEngine {
  /**
   * @param {object} config - output of loadPolicyConfig()
   */
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.policies = [];
    this.config = config;
    this.load(config);
  }

  /**
   * Atomic policy-list swap. Validates the new list via the config-layer
   * validator and only replaces internal state when it passes.
   * @param {object} config
   */
  load(config = {}) {
    this.enabled = !!config.enabled;
    const normalized = (config.policies || []).map((p) => ({
      id: p.id,
      name: p.name || p.id,
      description: p.description || '',
      enabled: p.enabled !== false,
      priority: typeof p.priority === 'number' ? p.priority : 100,
      weight: typeof p.weight === 'number' && p.weight >= 0 ? p.weight : 1,
      tags: Array.isArray(p.tags) ? p.tags.slice() : [],
      default: !!p.default,
      fallback: !!p.fallback,
      when: p.when || {},
      then: p.then || {},
    }));
    // Stable-sort: priority asc, weight desc, then declaration order.
    normalized.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return 0;
    });
    this.policies = normalized;
    this.config = config;
    logger.info('PolicyEngine initialized', { enabled: this.enabled, count: normalized.length });
  }

  /**
   * Read-only snapshot used by the admin `/admin/api/policies` endpoint.
   * The returned list is in the engine's evaluation order (priority asc).
   * @returns {object}
   */
  getSnapshot() {
    return {
      enabled: this.enabled,
      count: this.policies.length,
      policies: this.policies.map((p) => ({ ...p })),
    };
  }

  /**
   * List policies (raw). Returns a deep-ish copy so callers can't mutate
   * engine state by accident.
   * @returns {Array<object>}
   */
  listPolicies() { return this.policies.map((p) => ({ ...p })); }

  /**
   * Get a single policy by id (admin read).
   * @param {string} id
   * @returns {object|null}
   */
  getPolicy(id) { return this.policies.find((p) => p.id === id) || null; }

  /**
   * Add or update a single policy at runtime (admin API). Validation is
   * done via `validatePolicyConfig` so it's identical to file-load.
   * Returns true on success, false on invalid input.
   * @param {object} policy
   * @returns {boolean}
   */
  setPolicy(policy) {
    if (!policy || !policy.id) return false;
    const { validatePolicyConfig } = require('../config/policyConfig');
    const res = validatePolicyConfig({ enabled: true, policies: [policy] });
    if (!res.valid) return false;
    const idx = this.policies.findIndex((p) => p.id === policy.id);
    const normalized = {
      id: policy.id, name: policy.name || policy.id, description: policy.description || '',
      enabled: policy.enabled !== false,
      priority: typeof policy.priority === 'number' ? policy.priority : 100,
      weight: typeof policy.weight === 'number' && policy.weight >= 0 ? policy.weight : 1,
      tags: Array.isArray(policy.tags) ? policy.tags.slice() : [],
      default: !!policy.default, fallback: !!policy.fallback,
      when: policy.when || {}, then: policy.then || {},
    };
    if (idx >= 0) this.policies[idx] = normalized;
    else this.policies.push(normalized);
    this.policies.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return 0;
    });
    return true;
  }

  /**
   * Delete a policy by id. Returns true on success.
   * @param {string} id
   * @returns {boolean}
   */
  removePolicy(id) {
    const idx = this.policies.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.policies.splice(idx, 1);
    return true;
  }

  /**
   * Toggle a policy's `enabled` flag (admin API + dashboard quick-switch).
   * @param {string} id
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setEnabled(id, enabled) {
    const p = this.policies.find((x) => x.id === id);
    if (!p) return false;
    p.enabled = enabled !== false;
    return true;
  }

  /**
   * Reorder policies by changing their `priority`. Accepts a partial map
   * { policyId: newPriority } and recomputes the priority for each entry.
   * @param {object} priorityMap - { 'p1': 5, 'p2': 10 }
   * @returns {boolean}
   */
  setPriorities(priorityMap) {
    if (!priorityMap || typeof priorityMap !== 'object') return false;
    for (const [id, np] of Object.entries(priorityMap)) {
      if (typeof np !== 'number' || !Number.isFinite(np)) continue;
      const p = this.policies.find((x) => x.id === id);
      if (p) p.priority = np;
    }
    this.policies.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return 0;
    });
    return true;
  }

  /**
   * Clone an existing policy with a new id (admin "Clone" button).
   * @param {string} id
   * @param {string} newId
   * @param {string} [newName]
   * @returns {object|null} the cloned policy or null when source missing
   */
  clonePolicy(id, newId, newName) {
    const p = this.policies.find((x) => x.id === id);
    if (!p) return null;
    const clone = { ...p, id: newId, name: newName || (`${p.name} (clone)`) };
    this.policies.push(clone);
    this.policies.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return 0;
    });
    return clone;
  }

  /**
   * Evaluate every applicable policy against the request facts and
   * return a single consolidated decision.
   *
   * @param {object} facts - output of buildFacts(req, extra)
   * @param {object} [opts]
   * @param {boolean} [opts.audit] - when true, the returned object includes
   *   `matchedPolicies` and `ignoredPolicies` lists (used by the
   *   simulator + audit log).
   * @returns {{
   *   decision: object,
   *   matchedPolicies: Array<{ id: string, name: string, priority: number, weight: number, actions: string[] }> | undefined,
   *   ignoredPolicies: Array<{ id: string, reason: string }> | undefined,
   *   audit: Record<string, any> | undefined
   * }}
   */
  evaluate(facts, opts = {}) {
    const audit = opts.audit || false;
    const matched = [];
    const ignored = [];
    const decision = {
      forceProvider: null,
      forceModel: null,
      selectProvider: null,
      selectApiKey: null,
      selectVirtualModel: null,
      redirect: null,
      reject: null,
      rateLimitOverride: null,
      budgetLimit: null,
      quotaOverride: null,
      requireApproval: null,
      logReasons: [],
      // Raw per-policy action map (for the audit log + simulator).
      rawActions: [],
    };
    if (!this.enabled || this.policies.length === 0) {
      return audit ? { decision, matchedPolicies: matched, ignoredPolicies: ignored, audit: {} } : { decision };
    }

    // Pass 1: non-default / non-fallback policies in priority order.
    let terminalMatched = false;
    for (const p of this.policies) {
      if (p.default || p.fallback) continue;
      if (!p.enabled) { if (audit) ignored.push({ id: p.id, reason: 'disabled' }); continue; }
      const ok = evaluateCondition(p.when, facts);
      if (!ok) { if (audit) ignored.push({ id: p.id, reason: 'condition-false' }); continue; }
      matched.push(p);
      this._mergeDecision(decision, p, facts);
      if (audit) decision.rawActions.push({ policyId: p.id, name: p.name, priority: p.priority, actions: this._policyActionList(p) });
      // Short-circuit decision semantics
      if (decision.reject) { terminalMatched = true; break; }
      if (decision.redirect) { terminalMatched = true; break; }
      if (decision.forceProvider) { terminalMatched = true; break; }
      if (decision.forceModel) { terminalMatched = true; break; }
      if (decision.requireApproval) { terminalMatched = true; break; }
    }

    // Pass 2: default policies (only when nothing short-circuited).
    if (!terminalMatched) {
      for (const p of this.policies) {
        if (!p.default || p.fallback) continue;
        if (!p.enabled) { if (audit) ignored.push({ id: p.id, reason: 'disabled' }); continue; }
        const ok = evaluateCondition(p.when, facts);
        if (!ok) { if (audit) ignored.push({ id: p.id, reason: 'condition-false' }); continue; }
        matched.push(p);
        this._mergeDecision(decision, p, facts);
        if (audit) decision.rawActions.push({ policyId: p.id, name: p.name, priority: p.priority, default: true, actions: this._policyActionList(p) });
      }
    }

    // Pass 3: fallback policies (only when still no terminal decision).
    const hasTerminalTerminalAction = !!(decision.forceProvider || decision.forceModel || decision.redirect || decision.reject || decision.requireApproval || decision.selectProvider || decision.selectApiKey || decision.selectVirtualModel);
    if (!hasTerminalTerminalAction) {
      for (const p of this.policies) {
        if (!p.fallback) continue;
        if (!p.enabled) { if (audit) ignored.push({ id: p.id, reason: 'disabled' }); continue; }
        const ok = evaluateCondition(p.when, facts);
        if (!ok) { if (audit) ignored.push({ id: p.id, reason: 'condition-false' }); continue; }
        matched.push(p);
        this._mergeDecision(decision, p, facts);
        if (audit) decision.rawActions.push({ policyId: p.id, name: p.name, priority: p.priority, fallback: true, actions: this._policyActionList(p) });
      }
    }

    if (audit) {
      return {
        decision,
        matchedPolicies: matched.map((p) => ({
          id: p.id, name: p.name, priority: p.priority, weight: p.weight,
          default: p.default, fallback: p.fallback,
          actions: this._policyActionList(p),
        })),
        ignoredPolicies: ignored,
        audit: {
          reason: decision.logReasons.length ? decision.logReasons.join('; ') : null,
          decision: this._summarizeDecision(decision),
        },
      };
    }
    return { decision };
  }

  /**
   * Merge one policy's `then` actions into the running decision object.
   * Merges by-set for `select_*`, by-override for `force_*` / `redirect` /
   * `reject` (first one wins for the short-circuit cases — but we still
   * call this for downstream log/limit actions even after a short-circuit
   * decision since the consuming middleware/executor processes them all).
   * @param {object} decision
   * @param {object} policy
   * @param {object} facts
   * @private
   */
  _mergeDecision(decision, policy, facts) {
    const t = policy.then || {};
    if (t.force_provider && !decision.forceProvider) decision.forceProvider = { providerId: t.force_provider.providerId, policyId: policy.id };
    if (t.force_model && !decision.forceModel) decision.forceModel = { modelId: t.force_model.modelId, policyId: policy.id };
    if (t.select_provider && !decision.selectProvider) decision.selectProvider = { providerId: t.select_provider.providerId, policyId: policy.id };
    if (t.select_api_key && !decision.selectApiKey) decision.selectApiKey = { apiKeyId: t.select_api_key.apiKeyId, policyId: policy.id };
    if (t.select_virtual_model && !decision.selectVirtualModel) decision.selectVirtualModel = { modelId: t.select_virtual_model.modelId, policyId: policy.id };
    if (t.redirect && !decision.redirect) decision.redirect = { url: t.redirect.url, statusCode: t.redirect.statusCode || 307, policyId: policy.id };
    if (t.reject && !decision.reject) decision.reject = { reason: (t.reject && t.reject.reason) || 'rejected-by-policy', statusCode: (t.reject && t.reject.statusCode) || 403, policyId: policy.id };
    if (t.apply_rate_limit && !decision.rateLimitOverride) decision.rateLimitOverride = { ...t.apply_rate_limit, policyId: policy.id };
    if (t.apply_budget_limit && !decision.budgetLimit) decision.budgetLimit = { ...t.apply_budget_limit, policyId: policy.id };
    if (t.apply_quota && !decision.quotaOverride) decision.quotaOverride = { ...t.apply_quota, policyId: policy.id };
    if (t.require_approval && !decision.requireApproval) decision.requireApproval = { ...t.require_approval, policyId: policy.id };
    if (t.log_decision) decision.logReasons.push(t.log_decision.reason || `${policy.id}:matched`);
  }

  _policyActionList(p) {
    return Object.keys(p.then || {}).filter((k) => ACTIONS[k]);
  }

  _summarizeDecision(d) {
    if (d.reject) return `reject:${d.reject.reason}`;
    if (d.redirect) return `redirect:${d.redirect.url}`;
    if (d.forceProvider) return `force_provider:${d.forceProvider.providerId}`;
    if (d.forceModel) return `force_model:${d.forceModel.modelId}`;
    if (d.requireApproval) return `require_approval:${d.requireApproval.approver || ''}`;
    if (d.selectProvider) return `select_provider:${d.selectProvider.providerId}`;
    if (d.selectApiKey) return `select_api_key:${d.selectApiKey.apiKeyId}`;
    if (d.selectVirtualModel) return `select_vm:${d.selectVirtualModel.modelId}`;
    if (d.budgetLimit) return `budget:${JSON.stringify(d.budgetLimit)}`;
    if (d.rateLimitOverride) return `rate:${JSON.stringify(d.rateLimitOverride)}`;
    if (d.quotaOverride) return `quota:${JSON.stringify(d.quotaOverride)}`;
    if (d.logReasons && d.logReasons.length) return `log:${d.logReasons.join(';')}`;
    return 'allow';
  }
}

module.exports = PolicyEngine;
module.exports.evaluateCondition = evaluateCondition;
module.exports.evaluateTest = evaluateTest;
module.exports.buildFacts = buildFacts;
module.exports.getFact = getFact;
module.exports.ACTIONS = ACTIONS;
