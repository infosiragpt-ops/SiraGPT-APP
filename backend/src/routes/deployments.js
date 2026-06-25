'use strict';

/**
 * deployments route — Deployments / Publishing module (flag DEPLOYMENTS_V2).
 * A management clone of Replit's Deployments tab: status lifecycle, version
 * history, custom domains and a synthetic security scan. Bearer-auth (no CSRF,
 * same as codex) — scoped per user by the service layer.
 *
 *   GET    /api/deployments/health                  → { ok, enabled }   (público, SIEMPRE 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   GET    /api/deployments                          → lista del usuario
 *   GET    /api/deployments/providers                → estado Hostinger/AWS/GoDaddy
 *   POST   /api/deployments                          → crea
 *   GET    /api/deployments/:id                      → { deployment, versions, domains }
 *   PATCH  /api/deployments/:id                      → ajustes (commands/visibility/type/tier)
 *   POST   /api/deployments/:id/providers/connect    → conecta Hostinger VPS/AWS
 *   POST   /api/deployments/:id/publish              → publica versión (pipeline 5 fases)
 *   POST   /api/deployments/:id/rollback             → re-promociona una versión previa
 *   POST   /api/deployments/:id/pause|resume|shutdown
 *   POST   /api/deployments/:id/security-scan        → escaneo sintético
 *   POST   /api/deployments/:id/domains              → añade dominio (registros A+TXT)
 *   DELETE /api/deployments/:id/domains/:domainId
 *   GET    /api/deployments/:id/logs                 → { lines, entries, versionHash }
 *   POST   /api/deployments/:id/logs                 → registra log runtime autenticado
 *   GET    /api/deployments/:id/logs/client.js       → script publico de monitoreo runtime
 *   GET    /api/deployments/:id/logs/ingest          → beacon runtime con token de deployment
 *   POST   /api/deployments/:id/logs/ingest          → registra log runtime con token de deployment
 *   GET    /api/deployments/:id/logs/stream          → SSE live tail + heartbeat
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isDeploymentsEnabled } = require('../services/deployments/flags');
const service = require('../services/deployments/deployment-service');

const router = express.Router();

// EventSource can't set headers → allow a ?token= fallback for the SSE route
// (header still wins). Same shape as the codex/goals SSE routes.
function bearerFromQueryFallback(req, _res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    const token = String(req.query.token);
    if (token.length > 0 && token.length < 8192) req.headers.authorization = `Bearer ${token}`;
  }
  next();
}

function runtimeLogTokenFromRequest(req) {
  const header = req.get('x-sira-deployment-log-token') || req.get('x-deployment-log-token');
  if (header) return String(header);
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.query && req.query.token) return String(req.query.token);
  if (req.body && req.body.token) return String(req.body.token);
  return '';
}

function allowRuntimeLogIngest(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-sira-deployment-log-token, x-deployment-log-token, authorization',
    'Cache-Control': 'no-store',
  });
}

function runtimeMonitorScript(deploymentId, token) {
  return `;(() => {
  const deploymentId = ${JSON.stringify(deploymentId)};
  const token = ${JSON.stringify(token)};
  const script = document.currentScript;
  const base = script && script.src ? script.src : window.location.href;
  const ingest = new URL('/api/deployments/' + encodeURIComponent(deploymentId) + '/logs/ingest', base).toString();
  const trim = (value, max) => String(value == null ? '' : value).slice(0, max);
  const format = (value) => {
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const send = (payload) => {
    try {
      const q = new URLSearchParams();
      q.set('token', token);
      q.set('source', 'Runtime');
      q.set('level', payload.level || 'error');
      q.set('message', trim(payload.message || 'runtime error', 2400));
      q.set('url', trim(payload.url || window.location.href, 800));
      if (payload.stack) q.set('stack', trim(payload.stack, 2800));
      if (payload.line) q.set('line', String(payload.line));
      if (payload.column) q.set('column', String(payload.column));
      q.set('_', String(Date.now()));
      const image = new Image();
      image.src = ingest + '?' + q.toString();
    } catch {}
  };
  window.addEventListener('error', (event) => {
    send({
      level: 'error',
      message: event.message || 'window error',
      url: event.filename || window.location.href,
      line: event.lineno,
      column: event.colno,
      stack: event.error && event.error.stack,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    send({
      level: 'error',
      message: reason && reason.message ? reason.message : format(reason || 'unhandled rejection'),
      url: window.location.href,
      stack: reason && reason.stack,
    });
  });
  if (window.console && typeof window.console.error === 'function') {
    const nativeError = window.console.error;
    window.console.error = function patchedConsoleError(...args) {
      send({ level: 'error', message: args.map(format).join(' '), url: window.location.href });
      return nativeError.apply(this, args);
    };
  }
})();`;
}

// Público y SIEMPRE 200 (sin ETag, no-store) — el frontend decide si monta el
// módulo. Idéntico patrón al de codex/health.
router.get('/health', (_req, res) => {
  const payload = JSON.stringify({ ok: true, enabled: isDeploymentsEnabled() });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(payload);
});

router.use((req, res, next) => {
  if (!isDeploymentsEnabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

function sendError(res, err) {
  if (err && err.status && err.code) return res.status(err.status).json({ error: err.code, message: err.message });
  return res.status(500).json({ error: 'deployment_error', message: (err && err.message) || 'unexpected error' });
}

router.get('/', authenticateToken, async (req, res) => {
  try {
    return res.json({ deployments: await service.listDeployments({ userId: req.user.id }) });
  } catch (err) { return sendError(res, err); }
});

router.get('/providers', authenticateToken, async (_req, res) => {
  try {
    return res.json({ providers: service.listProviders() });
  } catch (err) { return sendError(res, err); }
});

router.post(
  '/',
  authenticateToken,
  [
    body('name').isString().bail().trim().isLength({ min: 1, max: 80 }).withMessage('name 1-80 chars'),
    body('deploymentType').optional().isString(),
    body('visibility').optional().isString(),
    body('geography').optional().isString(),
    body('machineTier').optional().isString(),
    body('projectId').optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const deployment = await service.createDeployment({
        userId: req.user.id,
        name: req.body.name.trim(),
        projectId: req.body.projectId || null,
        deploymentType: req.body.deploymentType || 'autoscale',
        visibility: req.body.visibility || 'public',
        geography: req.body.geography || 'na',
        machineTier: req.body.machineTier,
      });
      return res.status(201).json({ deployment });
    } catch (err) { return sendError(res, err); }
  },
);

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const detail = await service.getDeployment({ userId: req.user.id, id: req.params.id });
    if (!detail) return res.status(404).json({ error: 'deployment_not_found' });
    return res.json(detail);
  } catch (err) { return sendError(res, err); }
});

router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const deployment = await service.updateDeployment({ userId: req.user.id, id: req.params.id, patch: req.body || {} });
    return res.json({ deployment });
  } catch (err) { return sendError(res, err); }
});

router.post(
  '/:id/providers/connect',
  authenticateToken,
  [body('provider').isString().bail().trim().notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const result = await service.connectProvider({
        userId: req.user.id,
        id: req.params.id,
        providerId: req.body.provider,
      });
      return res.json(result);
    } catch (err) { return sendError(res, err); }
  },
);

router.post('/:id/publish', authenticateToken, async (req, res) => {
  try {
    const result = await service.publishDeployment({ userId: req.user.id, id: req.params.id, hasFiles: req.body?.hasFiles !== false });
    // The publish pipeline can complete the HTTP call yet still fail to promote
    // (e.g. a blocking security-scan phase). Reflect that at the HTTP layer with
    // 422 so a client polling on status alone doesn't read a failed build as a
    // successful publish. The body (with failedPhase/failureMessage) is unchanged.
    if (result && result.failedPhase) return res.status(422).json(result);
    return res.status(201).json(result);
  } catch (err) { return sendError(res, err); }
});

router.post('/:id/rollback', authenticateToken, [body('versionId').isString().bail().trim().notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  try {
    const result = await service.rollbackDeployment({ userId: req.user.id, id: req.params.id, versionId: req.body.versionId });
    return res.json(result);
  } catch (err) { return sendError(res, err); }
});

for (const [path, status, reason] of [['pause', 'paused', null], ['resume', 'running', null], ['shutdown', 'shut_down', null]]) {
  router.post(`/:id/${path}`, authenticateToken, async (req, res) => {
    try {
      const deployment = await service.setStatus({ userId: req.user.id, id: req.params.id, status, suspendedReason: reason });
      return res.json({ deployment });
    } catch (err) { return sendError(res, err); }
  });
}

router.post('/:id/security-scan', authenticateToken, async (req, res) => {
  try {
    return res.json({ scan: await service.runSecurityScan({ userId: req.user.id, id: req.params.id }) });
  } catch (err) { return sendError(res, err); }
});

router.post('/:id/domains', authenticateToken, [body('hostname').isString().bail().trim().notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  try {
    const domain = await service.addDomain({ userId: req.user.id, id: req.params.id, hostname: req.body.hostname });
    return res.status(201).json({ domain });
  } catch (err) { return sendError(res, err); }
});

router.post('/:id/domains/godaddy', authenticateToken, [body('hostname').isString().bail().trim().notEmpty()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  try {
    const result = await service.addDomain({
      userId: req.user.id,
      id: req.params.id,
      hostname: req.body.hostname,
      providerId: 'godaddy_dns',
    });
    return res.status(201).json(result);
  } catch (err) { return sendError(res, err); }
});

router.delete('/:id/domains/:domainId', authenticateToken, async (req, res) => {
  try {
    return res.json(await service.removeDomain({ userId: req.user.id, id: req.params.id, domainId: req.params.domainId }));
  } catch (err) { return sendError(res, err); }
});

router.post(
  '/:id/logs',
  authenticateToken,
  [
    body('message').optional().isString().isLength({ max: 8000 }),
    body('level').optional().isString().isLength({ max: 20 }),
    body('source').optional().isString().isLength({ max: 20 }),
    body('stack').optional().isString().isLength({ max: 8000 }),
    body('url').optional().isString().isLength({ max: 1000 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const entry = await service.recordRuntimeLog({ userId: req.user.id, id: req.params.id, payload: req.body || {} });
      return res.status(201).json({ entry });
    } catch (err) { return sendError(res, err); }
  },
);

router.options('/:id/logs/ingest', (req, res) => {
  allowRuntimeLogIngest(res);
  return res.status(204).end();
});

router.get('/:id/logs/client.js', async (req, res) => {
  const token = runtimeLogTokenFromRequest(req);
  if (!token || token.length > 256) return res.status(400).type('text/plain').send('missing deployment log token');
  return res
    .status(200)
    .set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    .send(runtimeMonitorScript(req.params.id, token));
});

router.get('/:id/logs/ingest', async (req, res) => {
  allowRuntimeLogIngest(res);
  try {
    const token = runtimeLogTokenFromRequest(req);
    await service.recordRuntimeLogByToken({ id: req.params.id, token, payload: req.query || {} });
    return res.status(204).end();
  } catch (err) {
    return res.status(err && err.status ? err.status : 500).end();
  }
});

router.post(
  '/:id/logs/ingest',
  [
    body('token').optional().isString().isLength({ min: 16, max: 256 }),
    body('message').optional().isString().isLength({ max: 8000 }),
    body('level').optional().isString().isLength({ max: 20 }),
    body('source').optional().isString().isLength({ max: 20 }),
    body('stack').optional().isString().isLength({ max: 8000 }),
    body('url').optional().isString().isLength({ max: 1000 }),
    body('line').optional().isNumeric(),
    body('column').optional().isNumeric(),
  ],
  async (req, res) => {
    allowRuntimeLogIngest(res);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const token = runtimeLogTokenFromRequest(req);
      const entry = await service.recordRuntimeLogByToken({ id: req.params.id, token, payload: req.body || {} });
      return res.status(202).json({ ok: true, entryId: entry.id, ts: entry.ts });
    } catch (err) { return sendError(res, err); }
  },
);

router.get('/:id/logs', authenticateToken, async (req, res) => {
  try {
    return res.json(await service.getLogs({ userId: req.user.id, id: req.params.id }));
  } catch (err) { return sendError(res, err); }
});

// SSE: replay recent logs once, then keep tailing new rows. Bearer via header
// or ?token=. Closes only on client disconnect.
router.get('/:id/logs/stream', bearerFromQueryFallback, authenticateToken, async (req, res) => {
  let payload;
  try {
    payload = await service.getLogs({ userId: req.user.id, id: req.params.id });
  } catch (err) { return sendError(res, err); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const seen = new Set();
  const keyFor = (entry) => entry.id || `${entry.ts}|${entry.source}|${entry.level}|${entry.deployment || ''}|${entry.message}`;
  const sendNewEntries = (entries = []) => {
    for (const entry of entries) {
      const key = keyFor(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      send('log', entry);
    }
  };

  send('open', { versionHash: payload.versionHash });
  sendNewEntries(payload.entries || []);

  let polling = false;
  const poll = setInterval(async () => {
    if (polling || closed) return;
    polling = true;
    try {
      const next = await service.getLogs({ userId: req.user.id, id: req.params.id });
      sendNewEntries(next.entries || []);
    } catch (err) {
      send('stream_error', { message: (err && err.message) || 'log stream error' });
    } finally {
      polling = false;
    }
  }, 1500);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
  });
});

module.exports = router;
