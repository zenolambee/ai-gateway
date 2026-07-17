const express = require('express');
const router = express.Router();
const appConfig = require('../config/appConfig');

router.get('/', (req, res) => {
  res.json({
    name: appConfig.name,
    version: appConfig.version,
    description: appConfig.description,
    defaultModel: appConfig.defaultModel,
  });
});

module.exports = router;
