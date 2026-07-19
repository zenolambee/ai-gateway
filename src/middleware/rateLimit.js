const AppError = require('../utils/AppError');

/**
 * Rate-limit middleware factory.
 *
 * Checks the request against the central RateLimiter. On rejection, returns
 * HTTP 429 with the OpenAI-compatible error envelope and rate-limit headers.
 * On success, passes through and attaches a response finish hook to release
 * the concurrency slot.
 *
 * The middleware runs AFTER auth (so `req.apiKey` is available) and BEFORE
 * the route handler. When the RateLimiter is disabled, it passes through
 * without any overhead.
 *
 * @param {object} deps
 * @param {object} deps.rateLimiter - RateLimiter instance
 * @param {object} [deps.metricsCollector] - optional MetricsCollector for rejected-request counts
 * @returns {Function} Express middleware
 */
function createRateLimitMiddleware({ rateLimiter, metricsCollector } = {}) {
  return (req, res, next) => {
    if (!rateLimiter || !rateLimiter.enabled) {
      return next();
    }

    // Extract scope keys from the request.
    const apiKeyId = req.apiKey ? req.apiKey.id : null;
    const model = (req.body && typeof req.body === 'object' && req.body.model)
      ? req.body.model
      : null;
    // Provider is not known at this stage (routing happens in the executor),
    // so per-provider limits are enforced as a no-op here. The executor can
    // call rateLimiter.check again if per-provider limiting is needed.

    const decision = rateLimiter.check({
      apiKeyId,
      model,
      now: Date.now(),
    });

    // Always set rate-limit headers on the response (OpenAI-compatible).
    if (decision.headers) {
      for (const [k, v] of Object.entries(decision.headers)) {
        res.setHeader(k, v);
      }
    }

    if (!decision.allowed) {
      // Record the rejection in metrics.
      if (metricsCollector) {
        metricsCollector.recordRateLimitRejection({
          scope: decision.scope,
          apiKeyId,
          model,
        });
      }

      const err = new AppError(
        `Rate limit exceeded. Retry after ${decision.retryAfterMs}ms.`,
        429,
        {
          code: 'RATE_LIMIT_EXCEEDED',
          requestId: req.requestId,
          retryAfterMs: decision.retryAfterMs,
          scope: decision.scope,
        }
      );
      return next(err);
    }

    // Release the concurrency slot when the response finishes.
    if (apiKeyId) {
      res.on('finish', () => {
        rateLimiter.release({ apiKeyId });
      });
    } else {
      res.on('finish', () => {
        rateLimiter.release({});
      });
    }

    next();
  };
}

module.exports = { createRateLimitMiddleware };
