const express = require('express');
const router = express.Router();
const { embeddingsService } = require('../services');

/**
 * POST /v1/embeddings
 *
 * OpenAI-compatible Embeddings endpoint. Embeddings are strictly
 * non-streaming — the request is validated, routed through the shared
 * RequestExecutor (with retry + fallback), and a single JSON response is
 * returned in the OpenAI `list` shape.
 *
 * Providers whose adapter declares `supportsEmbeddings:false` are filtered
 * out by the executor before the request is issued, and a 400
 * `embeddings_not_supported` error is returned if no candidate provider
 * supports the capability.
 */
router.post('/', async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const result = await embeddingsService.create(req.body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
