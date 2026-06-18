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
 *   POST   /api/deployments                          → crea
 *   GET    /api/deployments/:id                      → { deployment, versions, domains }
 *   PATCH  /api/deployments/:id                      → ajustes (commands/visibility/type/tier)
 *   POST   /api/deployments/:id/publish              → publica versión (pipeline 5 fases)
 *   POST   /api/deployments/:id/rollback             → re-promociona una versión previa
 *   POST   /api/deployments/:id/pause|resume|shutdown
 *   POST   /api/deployments/:id/security-scan        → escaneo sintético
 *   POST   /api/deployments/:id/domains              → añade dominio (registros A+TXT)
 *   DELETE /api/deployments/:id/domains/:domainId
 *   GET    /api/deployments/:id/logs                 → { lines, versionHash }
 *   GET    /api/deployments/:id/logs/stream          → SSE replay + heartbeat
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

router.post('/:id/publish', authenticateToken, async (req, res) => {
  try {
    const result = await service.publishDeployment({ userId: req.user.id, id: req.params.id, hasFiles: req.body?.hasFiles !== false });
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
    return res.status(201).json({ domain: await service.addDomain({ userId: req.user.id, id: req.params.id, hostname: req.body.hostname }) });
  } catch (err) { return sendError(res, err); }
});

router.delete('/:id/domains/:domainId', authenticateToken, async (req, res) => {
  try {
    return res.json(await service.removeDomain({ userId: req.user.id, id: req.params.id, domainId: req.params.domainId }));
  } catch (err) { return sendError(res, err); }
});

router.get('/:id/logs', authenticateToken, async (req, res) => {
  try {
    return res.json(await service.getLogs({ userId: req.user.id, id: req.params.id }));
  } catch (err) { return sendError(res, err); }
});

// SSE: replay the stored runtime log lines progressively, then heartbeat to keep
// the tail open. Bearer via header or ?token=. Closes on client disconnect.
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
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('open', { versionHash: payload.versionHash });

  let i = 0;
  const entries = payload.entries || [];
  const drain = setInterval(() => {
    if (i >= entries.length) { clearInterval(drain); send('eof', { count: entries.length }); return; }
    send('log', { ...entries[i], index: i });
    i += 1;
  }, 120);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(drain); clearInterval(heartbeat); });
});

module.exports = router;
