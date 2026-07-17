/**
 * Wraps an async route handler to catch any errors and forward them to the
 * Express error‑handling middleware via next(err). This eliminates the need
 * for manual try‑catch blocks inside each route.
 *
 * @param {Function} fn - Async route handler (req, res, next) => Promise
 * @returns {Function} Express middleware function
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
