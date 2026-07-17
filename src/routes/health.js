const express = require('express');
const router = express.Router();
const { version } = require('../../package.json');

router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', version, timestamp: new Date().toISOString() });
});

module.exports = router;
