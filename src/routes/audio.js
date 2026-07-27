const express = require('express');
const multer = require('multer');
const router = express.Router();
const { audioService } = require('../services');

/**
 * Audio API routes (OpenAI-compatible).
 *
 *   POST /v1/audio/speech          — JSON body, returns raw audio bytes (or
 *                                    JSON when response_format is json/verbose_json)
 *   POST /v1/audio/transcriptions — multipart/form-data, returns JSON { text }
 *   POST /v1/audio/translations  — multipart/form-data, returns JSON { text }
 *
 * Audio is strictly non-streaming — the request is validated, routed through
 * the shared RequestExecutor (with retry + fallback), and a single response
 * is returned.
 *
 * Providers whose adapter declares `supportsAudio:false` are filtered out by
 * the executor before the request is issued, and a 400 `audio_not_supported`
 * error is returned if no candidate provider supports the capability.
 */

// Map OpenAI audio response_format values to HTTP Content-Type headers for
// the binary speech response. Used when the provider returns raw audio bytes.
const AUDIO_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

// multer parses multipart/form-data into memory; file buffers are attached
// to req.file. JSON requests pass through untouched.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file (OpenAI limit)
});

// POST /v1/audio/speech — JSON body, binary audio response
router.post('/speech', async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const result = await audioService.speech(req.body, ctx);

    // If the normalized body is a Buffer, write raw audio bytes with the
    // appropriate Content-Type. Otherwise send the JSON body.
    if (Buffer.isBuffer(result.body)) {
      const fmt = req.body && req.body.response_format;
      const contentType = AUDIO_CONTENT_TYPES[fmt] || 'audio/mpeg';
      res.status(result.status);
      res.set('Content-Type', contentType);
      res.set('Content-Length', String(result.body.length));
      res.send(result.body);
    } else {
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    next(err);
  }
});

// POST /v1/audio/transcriptions — multipart/form-data
// Fields: file (required), model (required), language, prompt, response_format, temperature
router.post('/transcriptions', upload.single('file'), async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const body = { ...req.body };
    if (req.file) body.file = req.file;
    const result = await audioService.transcribe(body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

// POST /v1/audio/translations — multipart/form-data
// Fields: file (required), model (required), prompt, response_format, temperature
router.post('/translations', upload.single('file'), async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };
    const body = { ...req.body };
    if (req.file) body.file = req.file;
    const result = await audioService.translate(body, ctx);
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
