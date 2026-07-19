const AppError = require('../utils/AppError');

/**
 * Admin authentication middleware factory.
 *
 * Runs AFTER the regular auth middleware (which validates the Bearer token
 * and attaches `req.apiKey`). This middleware checks that the authenticated
 * key has the `admin` role. When auth is disabled (open-gateway mode), the
 * admin middleware also runs in open mode (no admin check) — this is the
 * expected behaviour for local development and testing.
 *
 * @param {object} deps
 * @param {object} deps.apiKeyStore - ApiKeyStore instance
 * @returns {Function} Express middleware
 */
function createAdminAuthMiddleware({ apiKeyStore } = {}) {
  return (req, res, next) => {
    // Open-gateway mode: no keys configured -> no admin check.
    if (!apiKeyStore || !apiKeyStore.isEnabled()) {
      return next();
    }

    // The regular auth middleware should have already run and attached
    // req.apiKey. If it didn't (e.g. the route is mounted before auth),
    // reject.
    if (!req.apiKey) {
      return next(new AppError(
        'Authentication required for admin access.',
        401,
        { code: 'MISSING_API_KEY', requestId: req.requestId }
      ));
    }

    if (!apiKeyStore.isAdmin(req.apiKey)) {
      return next(new AppError(
        'Admin role required for this endpoint.',
        403,
        { code: 'ADMIN_FORBIDDEN', requestId: req.requestId }
      ));
    }

    next();
  };
}

module.exports = { createAdminAuthMiddleware };
