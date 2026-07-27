/**
 * QuotaService
 *
 * Implements the Sprint 12 Quota Management matrix:
 *
 *   scope  : api_key | provider | virtual_model | user | organization | project
 *   limit  : requests | input_tokens | output_tokens | total_tokens | cost
 *   window : daily | weekly | monthly
 *   action : reject | switch_api_key | switch_provider | switch_virtual_model | continue | notify
 *
 * The service maintains per-policy/window rolling counters and exposes:
 *
 *   - checkAndConsume({ scope, scopeId, projected, dimensions, consume })
 *       pre-flight check (and optionally increment) returning an array of
 *       decisions, one per matching policy.
 *   - consume({ scope, scopeId, ...usage }) — increment counters after a
 *       successful response.
 *   - getSnapshot() / getPolicy() — admin dashboard read-only views.
 *
 * Existent rateLimiter behaviour (daily per-key request-token quotas with
 * hard 429 rejection) is preserved unchanged. This service sits NEXT to
 * it (runs after the rateLimiter middleware, before the route handler)
 * and extends policy coverage with the new scopes/actions. Operators who
 * keep `quotas.enabled=false` get zero behavioural change.
 *
 * Token-vs-cost accounting is delegated to a UsageAccounting instance
 * (which actually holds the cumulative per-(scope,id) totals); this
 * service queries that accounting for the "current" usage numbers.
 *
 * `action='reject'` → the middleware returns HTTP 429 with code
 * `QUOTA_EXCEEDED`. `action='continue'` only logs/analytics-emits and
 * lets the request through. `action='notify'` raises an alert but
 * passes through. The three `switch_*` actions are informational from
 * this service's perspective — they are translated by the middleware
 * into response header flags that the executor reads to re-route to a
 * different candidate (see quotaMiddleware.js).
 *
 * Rolling windows are aligned to calendar boundaries (UTC day, ISO week
 * starting Monday, calendar month) — same as the BudgetService. State is
 * purely in-memory; the policy list itself is persisted via config/quotas.json.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_APPROX = 30 * ONE_DAY_MS;

function windowStartMs(window, now) {
  if (window === 'daily') {
    const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime();
  }
  if (window === 'weekly') {
    const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
    const dow = d.getUTCDay();
    const offset = dow === 0 ? 6 : dow - 1;
    return d.getTime() - offset * ONE_DAY_MS;
  }
  // monthly — start of UTC calendar month
  const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime();
}

function windowResetMs(window) {
  if (window === 'daily') return ONE_DAY_MS;
  if (window === 'weekly') return ONE_WEEK_MS;
  return ONE_MONTH_APPROX;
}

const SCOPES = ['api_key', 'provider', 'virtual_model', 'user', 'organization', 'project'];

class QuotaService {
  /**
   * @param {object} config - output of loadQuotaConfig()
   */
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.policies = [];
    // counters: policyId -> { windowStart, requests, inputTokens, outputTokens, totalTokens, cost }
    this.counters = new Map();
    this.alerts = null; // AlertService (optional, injected)
    this.config = config;
    this.load(config);
  }

  load(config = {}) {
    this.enabled = !!config.enabled;
    this.policies = (config.policies || []).map((p) => ({
      id: p.id,
      name: p.name || p.id,
      scope: p.scope,
      scopeId: p.scopeId || null,
      limit: p.limit,
      window: p.window,
      value: typeof p.value === 'number' ? p.value : 0,
      action: p.action || 'reject',
      notifyTo: p.notifyTo || null,
    }));
    const ids = new Set(this.policies.map((p) => p.id));
    for (const id of this.counters.keys()) {
      if (!ids.has(id)) this.counters.delete(id);
    }
    this.config = config;
  }

  setAlertService(svc) { this.alerts = svc || null; }

  _ensure(policyId, now) {
    let c = this.counters.get(policyId);
    if (!c) {
      c = { windowStart: 0, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
      this.counters.set(policyId, c);
    }
    const p = this.policies.find((x) => x.id === policyId);
    if (!p) return c;
    const ws = windowStartMs(p.window, now);
    if (c.windowStart !== ws) {
      c.windowStart = ws;
      c.requests = 0; c.inputTokens = 0; c.outputTokens = 0; c.totalTokens = 0; c.cost = 0;
    }
    return c;
  }

  /**
   * Find policies applicable to a (scope, scopeId).
   * @param {string} scope
   * @param {string|null} scopeId
   * @returns {Array<object>}
   */
  _policiesFor(scope, scopeId) {
    return this.policies.filter((p) => {
      if (p.scope !== scope) return false;
      if (!p.scopeId) return true; // wildcard
      return p.scopeId === scopeId;
    });
  }

  /**
   * Read a counter's current value for a given `limit` kind.
   * @param {object} counter
   * @param {string} limitKind
   * @returns {number}
   */
  _readCounter(counter, limitKind) {
    switch (limitKind) {
      case 'requests': return counter.requests;
      case 'input_tokens': return counter.inputTokens;
      case 'output_tokens': return counter.outputTokens;
      case 'total_tokens': return counter.totalTokens;
      case 'cost': return counter.cost;
      default: return 0;
    }
  }

  /**
   * Increment a counter by an amount for a `limit` kind. -requests increments
   * requests; -cost increments cost; -tokens increments totalTokens AND the
   * input/output variant (when applicable).
   * @param {object} counter
   * @param {object} usage
   * @param {number} [usage.requests]
   * @param {number} [usage.inputTokens]
   * @param {number} [usage.outputTokens]
   * @param {number} [usage.totalTokens]
   * @param {number} [usage.cost]
   */
  _apply(counter, usage = {}) {
    if (usage.requests) counter.requests += usage.requests;
    if (usage.inputTokens) counter.inputTokens += usage.inputTokens;
    if (usage.outputTokens) counter.outputTokens += usage.outputTokens;
    if (usage.totalTokens) counter.totalTokens += usage.totalTokens;
    else {
      counter.totalTokens = counter.inputTokens + counter.outputTokens;
    }
    if (usage.cost) counter.cost = Math.round((counter.cost + usage.cost) * 1e8) / 1e8;
  }

  /**
   * Pre-flight check (and optionally increment) for a request BEFORE it is
   * sent upstream.
   *
   * @param {object} args
   * @param {string} args.scope
   * @param {string|null} [args.scopeId]
   * @param {object} [args.estimatedUsage] - { inputTokens, requests, cost, ... }
   * @param {boolean} [args.consume=true] - true: increment counters; false: dry run
   * @param {number} [args.now]
   * @returns {Array<{ policyId, name, scope, limit, window, value, current, projected, ratio, allowed: boolean, action: string, decision: 'ok'|'warn'|'exhausted'|'action', message: string, code: string|null }>}
   */
  check({ scope, scopeId, estimatedUsage = {}, consume = true, now } = {}) {
    if (!this.enabled) return [];
    const n = now || Date.now();
    const policies = this._policiesFor(scope, scopeId);
    const results = [];
    for (const p of policies) {
      const c = this._ensure(p.id, n);
      const cur = this._readCounter(c, p.limit);
      const estKey = p.limit === 'requests' ? 'requests'
        : p.limit === 'cost' ? 'cost'
          : p.limit === 'input_tokens' ? 'inputTokens'
            : p.limit === 'output_tokens' ? 'outputTokens'
              : 'totalTokens';
      const est = Math.max(0, estimatedUsage[estKey] || 0);
      const projected = cur + est;
      const ratio = p.value > 0 ? projected / p.value : 0;
      let decision = 'ok';
      let message = null;
      let code = null;
      let allowed = true;
      if (ratio >= 1) {
        decision = 'exhausted';
        message = `Quota "${p.name}" (${p.scope}/${p.limit}/${p.window}) exhausted`;
        code = 'QUOTA_EXCEEDED';
        if (p.action === 'reject') allowed = false;
        else allowed = true; // continue/notify/switch_* — emit decision but allow
      } else if (ratio >= 0.8) {
        decision = 'warn';
        message = `Quota "${p.name}" at ${(ratio * 100).toFixed(1)}% of ${p.value}`;
      }
      // Intentionally DO NOT auto-consume on pre-flight check — counters
      // advance only on `consume()` calls after the response is known.
      // This avoids double-counting when the middleware calls check() and
      // the executor calls consume() for the same request.
      if (decision === 'exhausted' || decision === 'warn') {
        if (p.action === 'notify' || p.action === 'continue' || p.action === 'reject' || p.action.startsWith('switch_')) {
          if (this.alerts && typeof this.alerts.raise === 'function') {
            this.alerts.raise({
              type: decision === 'exhausted' ? 'quota_exhausted' : 'quota_threshold',
              severity: decision === 'exhausted' ? 'critical' : 'warning',
              source: 'quota',
              message: message,
              context: {
                policyId: p.id,
                policyName: p.name,
                scope: p.scope,
                limit: p.limit,
                window: p.window,
                projected, current: cur, value: p.value, ratio,
                action: p.action,
                notifyTo: p.notifyTo,
              },
              dedupeKey: `quota:${p.id}:${c.windowStart}:${decision}`,
            });
          }
        }
      }
      results.push({
        policyId: p.id,
        name: p.name,
        scope: p.scope,
        limit: p.limit,
        window: p.window,
        value: p.value,
        current: cur,
        projected,
        ratio,
        allowed,
        action: p.action,
        decision,
        message,
        code,
        resetMs: windowResetMs(p.window),
      });
    }
    return results;
  }

  /**
   * Consume actual usage AFTER a successful response. Updates counters
   * for ALL matching policies for the request's known scopes. Note cost
   * and tokens are applied to ALL policy counters (each policy tracks all
   * of them; `limit` selects which comparison matters).
   *
   * @param {object} args
   * @param {string} [args.apiKeyId]   - for scope=api_key
   * @param {string} [args.providerId] - for scope=provider
   * @param {string} [args.virtualModelId] - for scope=virtual_model
   * @param {string} [args.userId]     - for scope=user
   * @param {string} [args.organizationId] - for scope=organization
   * @param {string} [args.projectId]  - for scope=project
   * @param {number} [args.inputTokens=0]
   * @param {number} [args.outputTokens=0]
   * @param {number} [args.totalTokens] - if omitted, computed
   * @param {number} [args.cost=0]
   * @param {number} [args.now]
   * @returns {number} number of policies whose counters were advanced
   */
  consume(args = {}) {
    if (!this.enabled) return 0;
    const usage = {
      requests: 1,
      inputTokens: args.inputTokens || 0,
      outputTokens: args.outputTokens || 0,
      totalTokens: args.totalTokens != null ? args.totalTokens : ((args.inputTokens || 0) + (args.outputTokens || 0)),
      cost: args.cost || 0,
    };
    const scopes = [
      ['api_key', args.apiKeyId],
      ['provider', args.providerId],
      ['virtual_model', args.virtualModelId],
      ['user', args.userId],
      ['organization', args.organizationId],
      ['project', args.projectId],
    ];
    const now = args.now || Date.now();
    let touched = 0;
    for (const [scope, scopeId] of scopes) {
      const policies = this._policiesFor(scope, scopeId);
      for (const p of policies) {
        const c = this._ensure(p.id, now);
        this._apply(c, usage);
        // Quota-exhausted alert on consume (when ratio crosses 1)
        const cur = this._readCounter(c, p.limit);
        const ratio = p.value > 0 ? cur / p.value : 0;
        if (ratio >= 1 && this.alerts && typeof this.alerts.raise === 'function') {
          this.alerts.raise({
            type: 'quota_exhausted',
            severity: 'critical',
            source: 'quota',
            message: `Quota "${p.name}" exhausted after consume (${this._readCounter(c, p.limit)}/${p.value})`,
            context: { policyId: p.id, scope: p.scope, limit: p.limit, window: p.window, current: cur, value: p.value, ratio, action: p.action },
            dedupeKey: `quota:${p.id}:${c.windowStart}:exhausted`,
          });
        }
        touched += 1;
      }
    }
    return touched;
  }

  getSnapshot() {
    const now = Date.now();
    return {
      enabled: this.enabled,
      policies: this.policies.map((p) => {
        const c = this._ensure(p.id, now);
        const cur = this._readCounter(c, p.limit);
        return {
          id: p.id,
          name: p.name,
          scope: p.scope,
          scopeId: p.scopeId,
          limit: p.limit,
          window: p.window,
          value: p.value,
          action: p.action,
          notifyTo: p.notifyTo,
          current: cur,
          ratio: p.value > 0 ? cur / p.value : 0,
          windowStart: c.windowStart,
          windowResetMs: windowResetMs(p.window),
          remaining: Math.max(0, p.value - cur),
          status: p.value > 0 && cur >= p.value ? 'exhausted'
            : p.value > 0 && cur >= p.value * 0.8 ? 'warning'
              : 'ok',
        };
      }),
    };
  }

  getPolicy(id) {
    return this.getSnapshot().policies.find((p) => p.id === id) || null;
  }

  reset() { this.counters.clear(); }
}

module.exports = QuotaService;
module.exports.SCOPES = SCOPES;
module.exports.windowStartMs = windowStartMs;
module.exports.windowResetMs = windowResetMs;
