const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const routes = require('./routes');
const adminRoutes = require('./routes/admin');
const { errorHandler, notFoundHandler, requestId, createAuthMiddleware, createRateLimitMiddleware, createAdminAuthMiddleware, createQuotaMiddleware, createPolicyMiddleware } = require('./middleware');
const { apiKeyStore, usageTracker, rateLimiter, metricsCollector, providerConfigManager, quotaService, budgetService, policyEngine, policyAudit } = require('./services');

// Load gateway API keys from config (config/apiKeys.json + GATEWAY_API_KEYS env).
apiKeyStore.load();

const app = express();

// Security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request ID (must run before logging so the id is available everywhere)
app.use(requestId());

// Authentication — protects every endpoint except public monitoring paths.
// When no API keys are configured the middleware runs in open-gateway mode.
const PUBLIC_PATHS = new Set(['/', '/health', '/ready', '/metrics', '/stats', '/health/providers']);
app.use((req, res, next) => {
  // Normalize the path for matching (strip trailing slash except root).
  const p = req.path === '/' ? '/' : req.path.replace(/\/$/, '');
  if (PUBLIC_PATHS.has(p)) return next();
  // Admin HTML dashboard is served without API auth (the UI handles its own
  // API key entry); the admin API endpoints below have their own auth.
  if (p === '/admin') return next();
  return createAuthMiddleware({ apiKeyStore, usageTracker })(req, res, next);
});

// Rate limiting — runs after auth (so req.apiKey is available) and before routes.
// When the RateLimiter is disabled, the middleware passes through.
app.use((req, res, next) => {
  const p = req.path === '/' ? '/' : req.path.replace(/\/$/, '');
  if (PUBLIC_PATHS.has(p) || p === '/admin') return next();
  return createRateLimitMiddleware({ rateLimiter, metricsCollector })(req, res, next);
});

// Sprint 12 — Quota & Budget enforcement. Opt-in (passes through when both
// services are disabled). Runs after rate-limit (so rate-limit headers are
// already set) and before the policy engine (so policies can override quota
// decisions via `apply_quota`).
app.use((req, res, next) => {
  const p = req.path === '/' ? '/' : req.path.replace(/\/$/, '');
  if (PUBLIC_PATHS.has(p) || p === '/admin') return next();
  return createQuotaMiddleware({ quotaService, budgetService })(req, res, next);
});

// Sprint 13 — Enterprise Policy Engine. Opt-in (passes through when the
// engine is disabled). Runs after quota so it can override those decisions;
// stashes routing hints on req.policyRouting for the executor / model router.
app.use((req, res, next) => {
  const p = req.path === '/' ? '/' : req.path.replace(/\/$/, '');
  if (PUBLIC_PATHS.has(p) || p === '/admin') return next();
  return createPolicyMiddleware({ policyEngine, policyAudit })(req, res, next);
});

// Logging
if (process.env.NODE_ENV !== 'test') {
  const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
  app.use(morgan(morganFormat));
}

// Admin dashboard HTML (served at /admin without API auth)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin API — requires admin-role auth (on top of the regular auth above).
app.use('/admin/api', (req, res, next) => {
  createAdminAuthMiddleware({ apiKeyStore })(req, res, next);
}, adminRoutes);

// Routes
app.use('/', routes);

// Start watching provider config files for hot reload (non-blocking).
if (process.env.NODE_ENV !== 'test') {
  providerConfigManager.startWatching();
}

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
