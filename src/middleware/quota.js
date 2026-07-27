const AppError = require('../utils/AppError');

/**
 * Quota & Budget middleware factory.
 *
 * Runs AFTER auth + rateLimit (when enabled) and BEFORE the route handler.
 * Performs two distinct pre-flight checks:
 *
 *   1. QuotaService.check({...}) for the active (api_key) scope.
 *      Returns 429 / code=QUOTA_EXCEEDED when any matching `reject`-action
 *      policy would be exhausted.
 *
 *   2. BudgetService.preCheck({...}) against the global budget + each
 *      project / organization / user budget associated with the request
 *      (props parsed from the request body or API-key metadata).
 *      Returns 429 / code=BUDGET_EXCEEDED on stop policies, and an
 *      `X-Budget-Warning` header when only the warn threshold is crossed.
 *
 * When neither service is enabled, the middleware is a no-op (zero added
 * latency for setups that haven't turned on quota/budget management).
 *
 * Sprint 12: ADDITIVE — the existing rateLimit middleware continues to
 * handle its existing policy matrix unchanged.
 *
 * @param {object} deps
 * @param {object} [deps.quotaService]
 * @param {object} [deps.budgetService]
 * @param {object} [deps.analyticsService] - optional, used to mark X-Quota-Switch responses
 * @returns {Function} Express middleware
 */
function createQuotaMiddleware({ quotaService, budgetService } = {}) {
  return (req, res, next) => {
    if (!req.apiKey) return next();
    const apiKeyId = req.apiKey.id;
    const projectId = (req.body && req.body.project_id) || (req.apiKey.projectId) || null;
    const organizationId = (req.body && req.body.organization_id) || (req.apiKey.organizationId) || null;
    const userId = (req.apiKey.userId) || apiKeyId;

    // ---- Quota pre-flight (api_key scope only here — provider/VM scopes
    // are checked by the executor post-routing, see requestQuotaHook). ----
    let quotaDecision = null;
    if (quotaService && quotaService.enabled) {
      const decisions = quotaService.check({
        scope: 'api_key',
        scopeId: apiKeyId,
        estimatedUsage: { requests: 1 }, // only the +1 request is known pre-route
        consume: false,
      });
      for (const d of decisions) {
        if (!d.allowed && d.action === 'reject') {
          const retryAfterSec = Math.ceil((d.resetMs || 60000) / 1000);
          res.setHeader('Retry-After', String(retryAfterSec));
          res.setHeader('X-Quota-Scope', d.scope);
          res.setHeader('X-Quota-Limit', String(d.value));
          res.setHeader('X-Quota-Current', String(d.current));
          return next(new AppError(d.message || 'Quota exceeded', 429, {
            code: 'QUOTA_EXCEEDED',
            requestId: req.requestId,
            retryAfterMs: d.resetMs || 60000,
            scope: d.scope,
            policyId: d.policyId,
          }));
        }
        if (d.action && d.action.startsWith('switch_')) {
          // Header signal so the executor can pick a different up-route.
          // The executor reads `req.quotaSwitch` and adjusts candidates.
          if (!req.quotaSwitch) req.quotaSwitch = [];
          req.quotaSwitch.push({ policyId: d.policyId, action: d.action });
        }
        quotaDecision = quotaDecision || d;
      }
    }

    // ---- User / organization / project scopes for quota pre-flight ----
    if (quotaService && quotaService.enabled) {
      const scopeIds = [['user', userId], ['organization', organizationId], ['project', projectId]];
      for (const [scope, scopeId] of scopeIds) {
        if (!scopeId) continue;
        const decisions = quotaService.check({ scope, scopeId, estimatedUsage: { requests: 1 }, consume: false });
        for (const d of decisions) {
          if (!d.allowed && d.action === 'reject') {
            return next(new AppError(d.message || 'Quota exceeded', 429, {
              code: 'QUOTA_EXCEEDED', requestId: req.requestId, retryAfterMs: d.resetMs || 60000, scope: d.scope, policyId: d.policyId,
            }));
          }
        }
      }
    }

    // ---- Budget pre-flight ----
    let budgetWarn = null;
    if (budgetService && budgetService.enabled) {
      const scopes = [
        // Global always applies.
        ['global', null],
      ];
      if (projectId) scopes.push(['project', projectId]);
      if (organizationId) scopes.push(['organization', organizationId]);
      if (userId) scopes.push(['user', userId]);
      // For pre-flight cost estimate, use the cheapest model known; when the
      // body has no model yet we fall back to estimating 0 cost (the budget
      // is only hit when consume() runs post-response with real cost).
      const estimate = 0; // conservative — we will reject-at-budget only when already over the limit
      for (const [scope, scopeId] of scopes) {
        const decisions = budgetService.preCheck({ scope, scopeId, estimatedCost: estimate });
        for (const d of decisions) {
          if (!d.allowed) {
            return next(new AppError(d.message || 'Budget exceeded', 429, {
              code: 'BUDGET_EXCEEDED', requestId: req.requestId, retryAfterMs: d.resetMs || 86400000, budgetId: d.budgetId,
            }));
          }
          if (d.code === 'BUDGET_WARNING' && !budgetWarn) budgetWarn = d;
        }
      }
    }

    // Soft-warning headers — request continues but client can observe the threshold.
    if (quotaDecision && quotaDecision.decision === 'warn') {
      res.setHeader('X-Quota-Warning', String(quotaDecision.policyId));
    }
    if (budgetWarn) {
      res.setHeader('X-Budget-Warning', String(budgetWarn.budgetId));
    }

    next();
  };
}

module.exports = { createQuotaMiddleware };
