const AppError = require('../utils/AppError');

/**
 * Authentication middleware factory.
 *
 * Extracts the Bearer token from the `Authorization` header, validates it
 * against the ApiKeyStore, enforces status/expiration, and attaches the key
 * record to `req.apiKey` for downstream usage tracking and restriction
 * checks.
 *
 * When the ApiKeyStore has no keys configured (`isEnabled() === false`), the
 * middleware runs in open-gateway mode: it passes through without requiring
 * a token. This keeps the gateway usable out-of-the-box and lets the test
 * suite run without auth.
 *
 * Provider and model restrictions are enforced here when the request body
 * is parseable (JSON). For multipart requests, the model restriction is
 * enforced later by the service layer (the model is in a form field, not
 * the JSON body). The middleware always attaches `req.apiKey` so services
 * can call `apiKeyStore.canAccessProvider`/`canAccessModel` themselves.
 *
 * Error responses follow the OpenAI error envelope (the global errorHandler
 * normalizes AppError instances).
 *
 * @param {object} deps
 * @param {object} deps.apiKeyStore - ApiKeyStore instance
 * @param {object} [deps.usageTracker] - optional UsageTracker instance
 * @returns {Function} Express middleware
 */
function createAuthMiddleware({ apiKeyStore, usageTracker } = {}) {
  return (req, res, next) => {
    // Open-gateway mode: no keys configured -> no auth.
    if (!apiKeyStore || !apiKeyStore.isEnabled()) {
      return next();
    }

    // Extract the Bearer token.
    const authHeader = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    const presentedKey = match ? match[1] : null;

    const result = apiKeyStore.validate(presentedKey);
    if (!result.valid) {
      const errMeta = result.error || { code: 'INVALID_API_KEY', message: 'Invalid API key.' };
      const statusCode = errMeta.code === 'MISSING_API_KEY' ? 401 : 401;
      return next(new AppError(errMeta.message, statusCode, {
        code: errMeta.code,
        requestId: req.requestId,
      }));
    }

    // Attach the key record for downstream restriction checks + usage tracking.
    req.apiKey = result.key;

    // Record the request in the usage tracker (request count).
    if (usageTracker && result.key) {
      usageTracker.recordRequest(result.key.id);
    }

    // Persist the per-key usage counter so it survives a restart (fire-and-forget).
    if (apiKeyStore && result.key && typeof apiKeyStore.recordUsage === 'function') {
      apiKeyStore.recordUsage(result.key.id).catch(() => {});
    }

    // Enforce model restriction when the model is in the JSON body.
    // (Multipart endpoints read the model from form fields later; the
    // service layer enforces restrictions there via req.apiKey.)
    if (result.key && req.body && typeof req.body === 'object' && req.body.model) {
      if (!apiKeyStore.canAccessModel(result.key, req.body.model)) {
        return next(new AppError(
          `This API key is not allowed to access model "${req.body.model}".`,
          403,
          { code: 'MODEL_FORBIDDEN', requestId: req.requestId, model: req.body.model }
        ));
      }
    }

    next();
  };
}

module.exports = { createAuthMiddleware };
