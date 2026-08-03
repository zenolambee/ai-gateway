/**
 * BudgetService
 *
 * Maintains per-budget rolling-cost counters and decides whether a new
 * request would push a budget past its warn/stop thresholds.
 *
 * A budget is identified by `id` and scoped to one of:
 *   - global            (every dollar the gateway spends)
 *   - project           (cost attributed to a project id)
 *   - organization      (cost attributed to an organization id)
 *   - user              (cost attributed to a user / gateway api-key id)
 *
 * Each budget has a window (daily|weekly|monthly). Windows are aligned to
 * calendar boundaries: daily=UTC day, weekly=ISO week (starting Monday UTC),
 * monthly=UTC month.
 *
 * Thresholds:
 *   - warnThresholdPercent (default 80) — generates a `budget_threshold`
 *     alert via the AlertService (when wired in) and emits the Warning
 *     header on responses. The request still goes through.
 *   - stopThresholdPercent (default 100) — when an incoming request would
 *     push a budget OVER the stop threshold AND `onExceed==='stop'`, the
 *     service returns `{ allowed: false, code: 'BUDGET_EXCEEDED', ... }`.
 *     When `onExceed==='warn'` it ALWAYS passes through (only alerts).
 *     When `onExceed==='continue'` it is purely informational (no alert,
 *     no header — dashboard-only).
 *
 * The service exposes `consume({ budgetId, cost })` called by the executor
 * AFTER a successful response (so a request that fails upstream is never
 * charged against a budget). Pre-flight enforcement happens via
 * `preCheck({ scope, scopeId, estimatedCost })` — the budget middleware
 * uses this to reject requests BEFORE the upstream call when the budget is
 * already at/over its stop threshold.
 *
 * All state is in-memory. Cost counters reset on rollover. The budgets
 * themselves are persisted to config/budgets.json via saveBudgetConfig().
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS; // 30-day approximation (matches rateLimiter)

function windowStartMs(window, now) {
  if (window === 'daily') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (window === 'weekly') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    // ISO week: Monday is the start. getUTCDay() returns 0..6 (Sun..Sat).
    const dow = d.getUTCDay(); // Sun=0..Sat=6
    const offset = dow === 0 ? 6 : dow - 1; // Mon=0..Sun=6
    return d.getTime() - offset * ONE_DAY_MS;
  }
  // monthly: start of UTC month
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function windowResetMs(window, startMs) {
  if (window === 'daily') return ONE_DAY_MS;
  if (window === 'weekly') return ONE_WEEK_MS;
  return ONE_MONTH_MS; // approximation
}

class BudgetService {
  /**
   * @param {object} config - output of loadBudgetConfig()
   * @param {object} [opts]
   * @param {object} [opts.storageProvider] - optional StorageProvider instance
   */
  constructor(config = {}, opts = {}) {
    this.enabled = !!config.enabled;
    this.budgets = [];
    this.counters = new Map();
    this.alerts = null;
    this.config = config;
    this._store = opts.storageProvider || null;
    this.load(config);
  }

  load(config = {}) {
    this.enabled = !!config.enabled;
    this.budgets = (config.budgets || []).map((b) => ({
      id: b.id,
      name: b.name || b.id,
      scope: b.scope || 'global',
      scopeId: b.scopeId || null,
      window: b.window || 'monthly',
      limit: typeof b.limit === 'number' ? b.limit : 0,
      currency: b.currency || 'USD',
      onExceed: b.onExceed || 'stop',
      warnThresholdPercent: typeof b.warnThresholdPercent === 'number' ? b.warnThresholdPercent : 80,
      stopThresholdPercent: typeof b.stopThresholdPercent === 'number' ? b.stopThresholdPercent : 100,
    }));
    // Keep existing counters (rolling windows live across reloads of the
    // budget list) but drop counters for budgets that no longer exist.
    const ids = new Set(this.budgets.map((b) => b.id));
    for (const id of this.counters.keys()) {
      if (!ids.has(id)) this.counters.delete(id);
    }
    this.config = config;
  }

  /**
   * Inject an alert service so threshold breaches raise alerts.
   * @param {object} alertService
   */
  setAlertService(alertService) {
    this.alerts = alertService || null;
  }

  _ensure(budgetId, now) {
    let c = this.counters.get(budgetId);
    if (!c) {
      c = { totalCost: 0, peakCost: 0, windowStart: 0, lastReset: 0 };
      this.counters.set(budgetId, c);
    }
    const b = this.budgets.find((x) => x.id === budgetId);
    if (!b) return c;
    const ws = windowStartMs(b.window, now);
    if (c.windowStart !== ws) {
      c.windowStart = ws;
      c.totalCost = 0;
      c.peakCost = 0;
      c.lastReset = now;
    }
    return c;
  }

  /**
   * Persist a budget counter to storage (fire-and-forget).
   */
  _persistCounter(budgetId) {
    if (!this._store) return;
    const c = this.counters.get(budgetId);
    if (!c) return;
    this._store.hset(`budget:${budgetId}`, {
      totalCost: c.totalCost,
      peakCost: c.peakCost,
      windowStart: c.windowStart,
      lastReset: c.lastReset,
    }).catch(() => {});
  }

  /**
   * Find the budgets that apply to a given (scope, scopeId) pair. A
   * matching scope with no scopeId matches any scopeId at that scope
   * level (acts as a wildcard for "every organization" / "every project").
   * @param {string} scope
   * @param {string|null} scopeId
   * @returns {Array<object>}
   */
  _budgetsFor(scope, scopeId) {
    if (!scope) return this.budgets.filter((b) => b.scope === 'global');
    return this.budgets.filter((b) => {
      if (b.scope !== scope) return false;
      if (b.scope === 'global') return true;
      if (!b.scopeId) return true; // wildcard
      return b.scopeId === scopeId;
    });
  }

  /**
   * Pre-flight check: would a projected `estimatedCost` request push any
   * matching budget OVER its stop threshold?
   *
   * @param {object} args
   * @param {string} [args.scope='global']
   * @param {string} [args.scopeId]
   * @param {number} [args.estimatedCost=0]
   * @returns {Array<{ allowed: boolean, budgetId: string, code: string|null, message: string, thresholdNowRatio: number, budgetId: string }>}
   */
  preCheck({ scope = 'global', scopeId = null, estimatedCost = 0, now } = {}) {
    if (!this.enabled) return [];
    const n = now || Date.now();
    const budgets = this._budgetsFor(scope, scopeId);
    const results = [];
    for (const b of budgets) {
      if (b.limit <= 0) continue; // 0-limit means disabled (informational)
      const c = this._ensure(b.id, n);
      const projected = c.totalCost + Math.max(0, estimatedCost || 0);
      const ratio = b.limit > 0 ? projected / b.limit : 0;
      if (ratio >= (b.stopThresholdPercent / 100) && b.onExceed === 'stop') {
        results.push({
          allowed: false,
          budgetId: b.id,
          budgetName: b.name,
          code: 'BUDGET_EXCEEDED',
          message: `Budget "${b.name}" (${b.window}/${b.scope}) limit of $${b.limit} would be exceeded`,
          thresholdNowRatio: ratio,
          window: b.window,
          resetMs: windowResetMs(b.window, c.windowStart),
          limit: b.limit,
          currentCost: c.totalCost,
        });
      } else if (ratio >= (b.warnThresholdPercent / 100)) {
        results.push({
          allowed: true,
          budgetId: b.id,
          budgetName: b.name,
          code: 'BUDGET_WARNING',
          message: `Budget "${b.name}" is at ${(ratio * 100).toFixed(1)}% of its $${b.limit} limit`,
          thresholdNowRatio: ratio,
          window: b.window,
          resetMs: windowResetMs(b.window, c.windowStart),
          limit: b.limit,
          currentCost: c.totalCost,
        });
      } else {
        results.push({
          allowed: true,
          budgetId: b.id,
          budgetName: b.name,
          code: null,
          message: null,
          thresholdNowRatio: ratio,
          window: b.window,
          resetMs: windowResetMs(b.window, c.windowStart),
          limit: b.limit,
          currentCost: c.totalCost,
        });
      }
    }
    return results;
  }

  /**
   * Consume `cost` against every matching budget. Should be called AFTER
   * a successful response. Idempotent for cost==0 (no-op). Each breach
   * emits a single alert (when an AlertService is wired in) — repeated
   * consumption past the same threshold will only alert once per window.
   * @param {object} args
   * @param {string} [args.scope='global']
   * @param {string} [args.scopeId]
   * @param {number} [args.cost=0]
   * @param {number} [args.now]
   * @returns {Array<{ budgetId, currentCost, ratio, breached: 'warn'|'stop'|null, alertRaised: boolean }>}
   */
  consume({ scope = 'global', scopeId = null, cost = 0, now } = {}) {
    if (!this.enabled || cost <= 0) return [];
    const n = now || Date.now();
    const budgets = this._budgetsFor(scope, scopeId);
    const results = [];
    for (const b of budgets) {
      if (b.limit <= 0) continue;
      const c = this._ensure(b.id, n);
      const before = c.totalCost;
      c.totalCost = Math.round((c.totalCost + cost) * 1e8) / 1e8;
      c.peakCost = Math.max(c.peakCost, c.totalCost);
      this._persistCounter(b.id);
      const ratioBefore = b.limit > 0 ? before / b.limit : 0;
      const ratioAfter = b.limit > 0 ? c.totalCost / b.limit : 0;
      const warnPct = b.warnThresholdPercent / 100;
      const stopPct = b.stopThresholdPercent / 100;
      let breached = null;
      if (ratioAfter >= stopPct && ratioBefore < stopPct) breached = 'stop';
      else if (ratioAfter >= warnPct && ratioBefore < warnPct) breached = 'warn';
      let alertRaised = false;
      if (breached && this.alerts && typeof this.alerts.raise === 'function') {
        this.alerts.raise({
          type: breached === 'stop' ? 'budget_exceeded' : 'budget_threshold',
          severity: breached === 'stop' ? 'critical' : 'warning',
          source: 'budget',
          message: `Budget "${b.name}" (${b.scope}/${b.window}) reached ${ratioAfter >= 1 ? '100%+' : (ratioAfter * 100).toFixed(1) + '%'} of $${b.limit}`,
          context: {
            budgetId: b.id,
            budgetName: b.name,
            window: b.window,
            scope: b.scope,
            scopeId: b.scopeId,
            limit: b.limit,
            currentCost: c.totalCost,
            ratio: ratioAfter,
          },
          dedupeKey: `budget:${b.id}:${c.windowStart}:${breached}`,
        });
        alertRaised = true;
      }
      results.push({
        budgetId: b.id,
        budgetName: b.name,
        currentCost: c.totalCost,
        ratio: ratioAfter,
        breached,
        alertRaised,
      });
    }
    return results;
  }

  /**
   * Read-only snapshot for the admin budget page.
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @returns {object}
   */
  getSnapshot(opts = {}) {
    const n = opts.now || Date.now();
    return {
      enabled: this.enabled,
      budgets: this.budgets.map((b) => {
        const c = this._ensure(b.id, n);
        const ratio = b.limit > 0 ? c.totalCost / b.limit : 0;
        return {
          id: b.id,
          name: b.name,
          scope: b.scope,
          scopeId: b.scopeId,
          window: b.window,
          limit: b.limit,
          currency: b.currency,
          currentCost: c.totalCost,
          peakCost: c.peakCost,
          ratio,
          warnThresholdPercent: b.warnThresholdPercent,
          stopThresholdPercent: b.stopThresholdPercent,
          onExceed: b.onExceed,
          windowStart: c.windowStart,
          windowResetMs: windowResetMs(b.window, c.windowStart),
          remaining: Math.max(0, b.limit - c.totalCost),
          status: ratio >= b.stopThresholdPercent / 100 ? 'exceeded'
            : ratio >= b.warnThresholdPercent / 100 ? 'warning'
              : 'ok',
        };
      }),
    };
  }

  /**
   * Get a single budget's status.
   * @param {string} budgetId
   * @param {number} [now]
   * @returns {object|null}
   */
  getBudget(budgetId, now) {
    const snap = this.getSnapshot({ now });
    return snap.budgets.find((b) => b.id === budgetId) || null;
  }

  /**
   * Reset all counters (for testing).
   */
  reset() {
    this.counters.clear();
  }
}

module.exports = BudgetService;
module.exports.ONE_DAY_MS = ONE_DAY_MS;
module.exports.ONE_WEEK_MS = ONE_WEEK_MS;
module.exports.ONE_MONTH_MS = ONE_MONTH_MS;
module.exports.windowStartMs = windowStartMs;
module.exports.windowResetMs = windowResetMs;
