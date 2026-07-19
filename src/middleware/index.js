const errorHandler = require('./errorHandler');
const notFoundHandler = require('./notFound');
const requestId = require('./requestId');
const asyncHandler = require('./asyncHandler');
const { createAuthMiddleware } = require('./auth');
const { createRateLimitMiddleware } = require('./rateLimit');
const { createAdminAuthMiddleware } = require('./adminAuth');

module.exports = {
  errorHandler,
  notFoundHandler,
  requestId,
  asyncHandler,
  createAuthMiddleware,
  createRateLimitMiddleware,
  createAdminAuthMiddleware,
};
