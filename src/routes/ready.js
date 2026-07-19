const express = require('express');
const router = express.Router();

/**
 * GET /ready
 *
 * Readiness probe (unauthenticated). Returns 200 when the gateway is ready
 * to serve requests (provider configs loaded). Unlike /health (liveness),
 * this endpoint reflects whether the gateway can actually route requests.
 */
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ready',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
