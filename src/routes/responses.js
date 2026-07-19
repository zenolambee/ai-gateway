const express = require('express');
const router = express.Router();
const { responsesService } = require('../services');

/**
 * POST /v1/responses
 *
 * OpenAI-compatible Responses API endpoint (streaming + non-streaming).
 *
 * When "stream": true is present in the request body, the gateway translates
 * the provider's Chat Completions streaming chunks into the Responses API
 * streaming event format (response.created, response.output_text.delta, ...)
 * and pipes them to the client via SSE.
 */
router.post('/', async (req, res, next) => {
  try {
    const ctx = { requestId: req.requestId, apiKey: req.apiKey };

    if (req.body && req.body.stream === true) {
      await responsesService.stream(req.body, res, ctx);
    } else {
      const result = await responsesService.create(req.body, ctx);
      res.status(result.status).json(result.body);
    }
  } catch (err) {
    // If SSE headers were already sent, the error happened mid-stream; the
    // executeStream pipeline already wrote an SSE error event, so we must not
    // try to send a JSON response (headers are locked).
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    next(err);
  }
});

module.exports = router;
