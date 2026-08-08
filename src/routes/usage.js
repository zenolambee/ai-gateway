const express = require('express');
const router = express.Router();
const { usageAnalyticsService } = require('../services');

/**
 * Self-service Usage & Quota endpoints (Prompt 24).
 *
 * Owner-scoped: a caller may ONLY read the usage/quota of the API key it
 * authenticated with (`req.apiKey`). There is no cross-key access here — that
 * is reserved for the admin aggregate endpoints under /admin/api/usage which
 * are protected by the admin-role middleware. This reuses the existing
 * authentication (req.apiKey set by the auth middleware) — no second auth
 * system.
 *
 *   GET /v1/usage         — the caller's own historical usage + quota
 *   GET /v1/usage/quota   — the caller's own quota analytics
 *
 * In open-gateway mode (no keys configured) req.apiKey is absent; we return a
 * 400 explaining that usage is per-API-key.
 */

function requireApiKey(req, res) {
  if (!req.apiKey || !req.apiKey.id) {
    res.status(400).json({
      error: {
        message: 'Per-key usage is only available when authenticated with an API key.',
        type: 'invalid_request_error',
        code: 'api_key_required',
        request_id: req.requestId,
      },
    });
    return null;
  }
  return req.apiKey.id;
}

router.get('/', (req, res, next) => {
  try {
    const id = requireApiKey(req, res);
    if (!id) return;
    res.json(usageAnalyticsService.getApiKeyUsage(id) || { apiKeyId: id, usage: null, quota: null });
  } catch (err) { next(err); }
});

router.get('/quota', (req, res, next) => {
  try {
    const id = requireApiKey(req, res);
    if (!id) return;
    res.json({ keyId: id, quota: usageAnalyticsService.getApiKeyQuota(id) || null });
  } catch (err) { next(err); }
});

module.exports = router;
