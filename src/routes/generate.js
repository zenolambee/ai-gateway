const express = require('express');
const router = express.Router();
const AppError = require('../utils/AppError');

router.post('/', async (req, res, next) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      throw new AppError('Prompt is required', 400);
    }
    // TODO: integrate actual AI service
    res.json({
      result: `Echo: ${prompt}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
