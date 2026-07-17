const express = require('express');
const router = express.Router();
const healthRoute = require('./health');
const generateRoute = require('./generate');
const modelsRoute = require('./models');
const infoRoute = require('./info');

router.use('/health', healthRoute);
router.use('/api/v1/generate', generateRoute);
router.use('/v1/models', modelsRoute);
router.use('/v1/info', infoRoute);

module.exports = router;
