const express = require('express');
const router = express.Router();
const { modelRegistry } = require('../services');
const AppError = require('../utils/AppError');

/**
 * Models API routes (OpenAI-compatible).
 *
 *   GET /v1/models        — list all models from all enabled providers
 *   GET /v1/models/:id    — retrieve a single model by id
 *
 * The ModelRegistry aggregates provider model catalogues, deduplicates
 * identical model ids, and caches the result with a configurable TTL.
 * Internal provider metadata is tracked but only the OpenAI-compatible
 * `{ id, object, created, owned_by }` shape is exposed to the client.
 *
 * If the cache is stale, the first request transparently triggers a refresh.
 */

// GET /v1/models
router.get('/', async (req, res, next) => {
  try {
    const result = await modelRegistry.listModelsResponse();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /v1/models/:id
router.get('/:id', async (req, res, next) => {
  try {
    const model = await modelRegistry.getModelResponse(req.params.id);
    if (!model) {
      throw new AppError(
        `The model '${req.params.id}' does not exist`,
        404,
        { code: 'MODEL_NOT_FOUND', model: req.params.id }
      );
    }
    res.json(model);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
