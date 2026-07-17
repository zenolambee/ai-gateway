const express = require('express');
const router = express.Router();
const appConfig = require('../config/appConfig');

router.get('/', (req, res) => {
  res.json({
    service: appConfig.name,
    version: appConfig.version,
    description: appConfig.description,
    defaultModel: appConfig.defaultModel,
    endpoints: {
      health: '/health',
      models: '/v1/models',
      generate: '/api/v1/generate',
      info: '/v1/info',
    },
  });
});

module.exports = router;
