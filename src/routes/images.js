const express = require('express');
const multer = require('multer');
const router = express.Router();
const { imagesService } = require('../services');

/**
 * Images API routes (OpenAI-compatible).
 *
 *   POST /v1/images/generations  — JSON body
 *   POST /v1/images/edits        — multipart/form-data (image + mask files)
 *   POST /v1/images/variations   — multipart/form-data (image file)
 *
 * Images are strictly non-streaming — the request is validated, routed
 * through the shared RequestExecutor (with retry + fallback), and a single
 * JSON response is returned in the OpenAI `images` shape.
 *
 * Providers whose adapter declares `supportsImages:false` are filtered out
 * by the executor before the request is issued, and a 400
 * `images_not_supported` error is returned if no candidate provider
 * supports the capability.
 */

// multer parses multipart/form-data into memory; file buffers are attached
// to req.files / req.file. JSON requests pass through untouched.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file (OpenAI limit)
});

// POST /v1/images/generations — JSON body
router.post('/generations', async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const result = await imagesService.generate(req.body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

// POST /v1/images/edits — multipart/form-data
// Fields: image (file, required), mask (file, optional), prompt, model, n, size, response_format, user
router.post('/edits', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'mask', maxCount: 1 },
]), async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    // Merge multer-parsed files into the body so the service/adapter can
    // access them uniformly via body.image / body.mask.
    const body = { ...req.body };
    if (req.files && req.files.image && req.files.image[0]) body.image = req.files.image[0];
    if (req.files && req.files.mask && req.files.mask[0]) body.mask = req.files.mask[0];
    const result = await imagesService.edit(body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

// POST /v1/images/variations — multipart/form-data
// Fields: image (file, required), model, n, size, response_format, user
router.post('/variations', upload.single('image'), async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const body = { ...req.body };
    if (req.file) body.image = req.file;
    const result = await imagesService.variation(body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
