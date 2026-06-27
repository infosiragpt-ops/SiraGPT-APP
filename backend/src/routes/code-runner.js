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
const { Readable } = require('stream');
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

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function proxiedPath(req) {
  const marker = `/api/code-runner/${encodeURIComponent(req.params.runId)}/proxy`;
  const raw = req.originalUrl || req.url || '/';
  const idx = raw.indexOf(marker);
  if (idx === -1) return '/';
  const rest = raw.slice(idx + marker.length);
  return rest ? rest : '/';
}

// Authenticated preview proxy. In production the browser cannot iframe the
// backend container's localhost port, so the runner exposes each dev server
// through this same-origin path instead of opening dynamic public ports.
router.use('/:runId/proxy', authenticateToken, async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const target = hostRunner.getProxyTarget(req.params.runId, req.user.id);
  if (target.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (target.error === 'not_found') return res.status(404).json({ error: 'run_not_found' });
  if (target.error === 'not_ready') {
    return res.status(503).json({ error: 'run_not_ready', phase: target.phase, message: target.message });
  }

  const suffix = proxiedPath(req);
  const upstreamUrl = `http://127.0.0.1:${target.port}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${target.port}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.CODE_RUNNER_PROXY_TIMEOUT_MS) || 30_000),
    });
  } catch (err) {
    return res.status(502).json({ error: 'preview_proxy_failed', message: err.message });
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    // Keep the iframe same-origin and avoid stale dev-server assets after edits.
    if (lower === 'content-security-policy') return;
    res.setHeader(key, value);
  });
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'HEAD' || !upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
});

module.exports = router;
