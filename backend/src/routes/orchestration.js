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

// GET /api/orchestration/health/ready — readiness probe.
// Returns 200 when the wireup can be created and reports a usable
// gateway (the only universally-required subsystem). 503 otherwise.
// Use this from K8s readinessProbe or load-balancer health checks
// so the pod is only added to rotation once orchestration boots.
router.get('/health/ready', async (_req, res) => {
  try {
    const { getOrchestrationWireup } = require('../orchestration/orchestration-wireup');
    const wireup = getOrchestrationWireup(process.env);
    const snapshot = await wireup.health();
    const ok = Boolean(snapshot && snapshot.gateway);
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ready' : 'not_ready',
      gateway: Boolean(snapshot && snapshot.gateway),
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      error: err && err.message ? err.message : 'orchestration wireup failed to boot',
    });
  }
});

// GET /api/orchestration/health/live — liveness probe.
// Always returns 200 as long as the route is reachable. Use this
// from K8s livenessProbe — orchestration itself never crashes the
// process even when every external dep is down (all subsystems
// degrade to no-op), so liveness is the same as "process up".
router.get('/health/live', (_req, res) => {
  res.json({ status: 'alive', timestamp: Date.now() });
});

module.exports = router;
