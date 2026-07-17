const express = require('express');
const router = express.Router();
const config = require('../config');

router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: config.version,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
