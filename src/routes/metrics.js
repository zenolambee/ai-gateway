const express = require('express');
const router = express.Router();
const { metricsCollector, healthMonitor } = require('../services');

/**
 * Metrics & Monitoring routes.
 *
 *   GET /metrics           — full metrics snapshot (global + per-provider)
 *   GET /stats             — lightweight stats summary
 *   GET /health/providers  — per-provider health + circuit-breaker state
 *
 * These endpoints are read-only and never block request execution — the
 * MetricsCollector and ProviderHealthMonitor update synchronously in
 * O(1) per request event, and these routes simply project the current
 * in-memory state.
 *
 * The same router is mounted at /metrics, /stats, and /health/providers.
 * Each handler checks the mount path (req.baseUrl) to return the right view.
 */

router.get('/', (req, res) => {
  const mount = req.baseUrl;
  if (mount === '/stats') {
    return res.json(metricsCollector.getStats());
  }
  if (mount === '/health/providers') {
    return res.json({ providers: healthMonitor.getAllHealth() });
  }
  // Default: /metrics
  res.json(metricsCollector.getSnapshot());
});

module.exports = router;
