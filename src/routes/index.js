const express = require('express');
const router = express.Router();
const healthRoute = require('./health');
const generateRoute = require('./generate');
const modelsRoute = require('./models');

router.use('/health', healthRoute);
router.use('/api/v1/generate', generateRoute);
router.use('/v1/models', modelsRoute);

module.exports = router;
