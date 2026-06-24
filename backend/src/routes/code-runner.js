'use strict';

/**
 * code-runner route — drives the no-Docker host runner that boots a generated
 * project as a REAL dev server (vite/next dev) on a localhost port, so the /code
 * preview can iframe `http://localhost:<port>` with native HMR.
 *
 *   GET  /api/code-runner/health         → { ok, enabled }            (public)
 *   POST /api/code-runner/start          → { runId, phase, devUrl }   (auth)
 *   GET  /api/code-runner/:runId/status  → { running, ready, ... }    (auth)
 *   POST /api/code-runner/:runId/stop    → { ok }                      (auth)
 *
 * Disabled in production by default (see host-runner.enabled); the prod/Docker
 * path stays on /api/opencode.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const hostRunner = require('../services/code/host-runner');

const router = express.Router();

// Public: lets the UI pick the host runner (local) vs the opencode/Docker path.
router.get('/health', (req, res) => {
  res.json({ ok: true, enabled: hostRunner.enabled() });
});

router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { runId, files } = req.body || {};
    const out = await hostRunner.startRun({ runId, userId: req.user.id, files });
    return res.json(out);
  } catch (err) {
    if (err && err.code === 'disabled') {
      return res.status(503).json({ error: 'host_runner_disabled', message: 'El runner local está desactivado en este entorno.' });
    }
    if (err && err.code === 'no_package') {
      return res.status(400).json({ error: 'no_package', message: err.message });
    }
    return res.status(500).json({ error: 'start_failed', message: err.message });
  }
});

router.get('/:runId/status', authenticateToken, (req, res) => {
  const st = hostRunner.getStatus(req.params.runId, req.user.id);
  if (st === null) return res.status(403).json({ error: 'forbidden' });
  return res.json(st);
});

router.post('/:runId/stop', authenticateToken, (req, res) => {
  hostRunner.stopRun(req.params.runId);
  return res.json({ ok: true });
});

module.exports = router;
