const express = require('express');
const router = express.Router();
const healthRoute = require('./health');
const generateRoute = require('./generate');

router.use('/health', healthRoute);
router.use('/api/v1/generate', generateRoute);

module.exports = router;
