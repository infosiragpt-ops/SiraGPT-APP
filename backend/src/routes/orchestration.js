'use strict';

const express = require('express');
const { optionalAuth } = require('../middleware/optionalAuth');

const router = express.Router();

// GET /api/orchestration/health — returns the wireup health snapshot
// (gateway, semanticCache, r2Storage, checkpointStore, memory, search,
// multichannel, multiAgent). Booleans + shape only; never returns key
// values. Safe to call anonymously so operators can monitor which
// subsystems are activated by the current env without auth.
router.get('/health', optionalAuth, async (_req, res) => {
  try {
    const { getOrchestrationWireup } = require('../orchestration/orchestration-wireup');
    const wireup = getOrchestrationWireup(process.env);
    const snapshot = await wireup.health();
    res.json(snapshot);
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err && err.message ? err.message : 'orchestration health check failed',
    });
  }
});

module.exports = router;
