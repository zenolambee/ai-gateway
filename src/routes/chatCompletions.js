const express = require('express');
const router = express.Router();
const { chatCompletionsService } = require('../services');

/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible Chat Completions endpoint (streaming + non-streaming).
 *
 * When "stream": true is present in the request body, the gateway pipes
 * Server-Sent Events from the provider to the client using the shared
 * streaming pipeline (StreamParser -> StreamingResponseAdapter -> SSEWriter).
 * Otherwise it returns a single JSON response.
 */
router.post('/', async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey, policyRouting: req.policyRouting || null, policyBudgetLimit: req.policyBudgetLimit || null, policyRateLimitOverride: req.policyRateLimitOverride || null, policyQuotaOverride: req.policyQuotaOverride || null };

    if (req.body && req.body.stream === true) {
      await chatCompletionsService.stream(req.body, res, ctx);
    } else {
      const result = await chatCompletionsService.complete(req.body, ctx);
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    // If SSE headers were already sent, the error happened mid-stream; the
    // executeStream pipeline already wrote an SSE error event, so we must not
    // try to send a JSON response (headers are locked).
    if (res.headersSent) {
      // Ensure the response is ended
      if (!res.writableEnded) res.end();
      return;
    }
    next(err);
  }
});

module.exports = router;
