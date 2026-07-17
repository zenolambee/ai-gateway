const express = require('express');
const router = express.Router();
const AppError = require('../utils/AppError');
const aiService = require('../services/aiService');

router.post('/', async (req, res, next) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      throw new AppError('Prompt is required', 400);
    }

    const result = await aiService.generate(prompt);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
