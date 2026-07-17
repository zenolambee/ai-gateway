const express = require('express');
const router = express.Router();
const AppError = require('../utils/AppError');
const aiService = require('../services/aiService');
const config = require('../config');
const asyncHandler = require('../middleware/asyncHandler');

router.post('/', asyncHandler(async (req, res, next) => {
  const { prompt, model } = req.body;
  if (!prompt) {
    throw new AppError('Prompt is required', 400);
  }

  // Use provided model or fall back to default
  const activeModel = model || config.aiModel;
  const result = await aiService.generate(prompt, activeModel);
  res.json({ result });
}));

module.exports = router;
