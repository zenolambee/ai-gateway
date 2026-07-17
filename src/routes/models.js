const express = require('express');
const router = express.Router();
const config = require('../config');

router.get('/', (req, res) => {
  res.json({
    object: 'list',
    data: config.modelsList,
  });
});

module.exports = router;
