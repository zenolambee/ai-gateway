const AppError = require('../utils/AppError');
const { buildFacts } = require('../services/policyEngine');

/**
 * Policy middleware factory (Sprint 13).
 *
 * Runs AFTER auth (so req.apiKey is available) and AFTER rateLimit /
 * quota (since the policy engine may OVERRIDE their decisions via
 * `apply_quota`/`apply_rate_limit`). It runs BEFORE the route handler so
 * the routing decisions (`force_provider`, `select_provider`, etc.) can
 * be consumed by the request executor / model router.
 *
 * The middleware is OPT-IN — when no policy engine is attached or the
 * engine is disabled, it is a zero-overhead pass-through (preserving
 * full backward compatibility for deployments that haven't enabled the
 * enterprise policy layer).
 *
 * On every evaluated request, it:
 *   1. Builds the standardised `facts` object.
 *   2. Evaluates the engine in audit mode.
 *   3. Stashes the decision on `req.policyDecision` and routing hints on
 *      `req.policyRouting` for downstream phases.
 *   4. Short-circuits with HTTP 403 (`reject`), 307 (`redirect`), or 418
 *      (`require_approval`) — these status codes match the OpenAI error
 *      envelope so clients can parse them gracefully.
 *   5. Records the audit entry (matched policies + decision + execution
 *      time) into the PolicyAuditService — best-effort, never blocks.
 *
 * @param {object} deps
 * @param {object} [deps.policyEngine] - PolicyEngine instance
 * @param {object} [deps.policyAudit] - PolicyAuditService instance
 * @returns {Function} Express middleware
 */
function createPolicyMiddleware({ policyEngine, policyAudit } = {}) {
  return (req, res, next) => {
    if (!policyEngine || !policyEngine.enabled) return next();
    const startedAt = Date.now();
    const facts = buildFacts(req, { now: startedAt, operation: _inferOperation(req) });
    let evalRes;
    try {
      evalRes = policyEngine.evaluate(facts, { audit: true });
    } catch (err) {
      // Engine panic: NEVER block the request — let the normal routing take
      // over. The executor's existing bypass paths guarantee availability.
      if (policyAudit) {
        try { policyAudit.record({ requestId: req.requestId, apiKeyId: req.apiKey ? req.apiKey.id : null, decision: null, routingDecision: 'engine-error', reason: err && err.message, executionTimeMs: Date.now() - startedAt, timestamp: startedAt, ignoredPolicies: [], matchedPolicies: [] }); } catch (_) {}
      }
      return next();
    }
    const d = evalRes.decision;
    req.policyDecision = d;
    req.policyMatchedPolicies = evalRes.matchedPolicies || [];
    req.policyIgnoredPolicies = evalRes.ignoredPolicies || [];

    // Public headers so clients observe the engine's involvement.
    if (d.reject) res.setHeader('X-Policy-Decision', 'reject');
    else if (d.redirect) res.setHeader('X-Policy-Decision', 'redirect');
    else if (d.forceProvider) res.setHeader('X-Policy-Decision', 'force-provider');
    else if (d.selectProvider) res.setHeader('X-Policy-Decision', 'select-provider');
    else if (d.forceModel) res.setHeader('X-Policy-Decision', 'force-model');
    else if (d.requireApproval) res.setHeader('X-Policy-Decision', 'require-approval');
    else res.setHeader('X-Policy-Decision', 'allow');

    // Pass routing hints to the executor / model router (post-route).
    req.policyRouting = {
      forceProvider: d.forceProvider && d.forceProvider.providerId,
      forceModel: d.forceModel && d.forceModel.modelId,
      selectProvider: d.selectProvider && d.selectProvider.providerId,
      selectApiKey: d.selectApiKey && d.selectApiKey.apiKeyId,
      selectVirtualModel: d.selectVirtualModel && d.selectVirtualModel.modelId,
    };
    req.policyBudgetLimit = d.budgetLimit || null;
    req.policyRateLimitOverride = d.rateLimitOverride || null;
    req.policyQuotaOverride = d.quotaOverride || null;
    req.policyRequireApproval = d.requireApproval || null;

    // Short-circuit decisions.
    if (d.reject) {
      if (policyAudit) {
        try { policyAudit.record({ requestId: req.requestId, apiKeyId: req.apiKey ? req.apiKey.id : null, model: req.body && req.body.model, matchedPolicies: req.policyMatchedPolicies, ignoredPolicies: req.policyIgnoredPolicies, decision: d, routingDecision: `reject:${d.reject.reason}`, rejected: true, reason: d.reject.reason, executionTimeMs: Date.now() - startedAt, timestamp: startedAt }); } catch (_) {}
      }
      return next(new AppError(d.reject.reason || 'Request rejected by policy', d.reject.statusCode || 403, {
        code: 'POLICY_REJECT',
        requestId: req.requestId,
        policyId: d.reject.policyId,
      }));
    }
    if (d.redirect) {
      if (policyAudit) {
        try { policyAudit.record({ requestId: req.requestId, apiKeyId: req.apiKey ? req.apiKey.id : null, matchedPolicies: req.policyMatchedPolicies, ignoredPolicies: req.policyIgnoredPolicies, decision: d, routingDecision: `redirect:${d.redirect.url}`, reason: `redirect to ${d.redirect.url}`, executionTimeMs: Date.now() - startedAt, timestamp: startedAt }); } catch (_) {}
      }
      return res.redirect(d.redirect.statusCode || 307, d.redirect.url);
    }
    if (d.requireApproval) {
      if (policyAudit) {
        try { policyAudit.record({ requestId: req.requestId, apiKeyId: req.apiKey ? req.apiKey.id : null, matchedPolicies: req.policyMatchedPolicies, ignoredPolicies: req.policyIgnoredPolicies, decision: d, routingDecision: 'require-approval', reason: 'approval-required', executionTimeMs: Date.now() - startedAt, timestamp: startedAt }); } catch (_) {}
      }
      return next(new AppError(`Request requires approval from ${d.requireApproval.approver || 'admin'}`, 418, {
        code: 'POLICY_APPROVAL_REQUIRED',
        requestId: req.requestId,
        policyId: d.requireApproval.policyId,
      }));
    }

    // Audit-record the allow (queued to next tick so it never blocks the request).
    if (policyAudit) {
      const finalProviderId = null;
      try {
        setImmediate(() => {
          try { policyAudit.record({
            requestId: req.requestId, apiKeyId: req.apiKey ? req.apiKey.id : null,
            model: req.body && req.body.model, operation: _inferOperation(req),
            matchedPolicies: req.policyMatchedPolicies, ignoredPolicies: req.policyIgnoredPolicies,
            decision: d, routingDecision: evalRes.audit && evalRes.audit.decision,
            reason: d.logReasons && d.logReasons.length ? d.logReasons.join(';') : null,
            executionTimeMs: Date.now() - startedAt, timestamp: startedAt,
          }); } catch (_) {}
        });
      } catch (_) {}
    }

    next();
  };
}

function _inferOperation(req) {
  const p = req.path || req.baseUrl || '';
  if (p.includes('/chat/')) return 'chat';
  if (p.includes('/responses')) return 'responses';
  if (p.includes('/embeddings')) return 'embeddings';
  if (p.includes('/images')) return 'images';
  if (p.includes('/audio')) return 'audio';
  return null;
}

module.exports = { createPolicyMiddleware };
