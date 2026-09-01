'use strict';

/**
 * /api/opencode — public prefix for SiraCode (native Node engine).
 *
 * Phase 1: the Bun sidecar / OPENCODE_SERVER_URL path is ignored unless
 * SIRAGPT_OPENCODE_SIDECAR=1 (fail-closed, off by default, unused here).
 *
 *   GET  /api/opencode/health
 *   POST /api/opencode/session
 *   POST /api/opencode/session/:id/prompt
 *   POST /api/opencode/session/:id/agent
 *   POST /api/opencode/session/:id/abort
 *   POST /api/opencode/session/:id/permission
 *   GET  /api/opencode/file
 *   GET  /api/opencode/files
 *   GET  /api/opencode/events
 *   POST /api/opencode/run  (+ /run/status, /run/stop)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const siraCode = require('../services/sira-code');

const router = express.Router();

function userIdOf(req) {
  return req.user && (req.user.id || req.user.userId || req.user.sub) || null;
}

function fail(res, err, code = 'sira_code_error') {
  const status = Number(err && err.status) || 500;
  if (status >= 500) {
    console.error(`[sira-code] ${code}:`, (err && err.message) || err);
    return res.status(500).json({ error: code, message: 'Error interno del motor' });
  }
  return res.status(status).json({
    error: err.code || code,
    message: err.message || 'solicitud inválida',
  });
}

function upstreamFail(res, err, code = 'opencode_upstream') {
  console.error(`[opencode] ${code}:`, (err && err.message) || err);
  return res.status(502).json({ error: code, message: 'Upstream service error' });
}

router.get('/health', (req, res) => {
  res.json(siraCode.health());
});

router.get('/agents', authenticateToken, (req, res) => {
  res.json({ agents: siraCode.listPublicAgents() });
});

router.post('/session', authenticateToken, async (req, res) => {
  try {
    const seed = req.body && typeof req.body === 'object'
      ? (req.body.session && typeof req.body.session === 'object' ? req.body.session : req.body)
      : {};
    const session = await siraCode.create({
      userId: userIdOf(req),
      agent: seed.agent || seed.agentId,
      model: seed.model,
      title: seed.title,
    });
    return res.json({ session });
  } catch (err) {
    return fail(res, err);
  }
});

router.post(
  '/session/:id/prompt',
  authenticateToken,
  [
    body('text').isString().withMessage('text must be a string').bail().trim().notEmpty().withMessage('text is required'),
    body('permission').optional().isString().isIn(['default', 'read', 'protected', 'workspace', 'full']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const result = await siraCode.prompt(req.params.id, req.body.text, {
        userId: userIdOf(req),
        agent: req.body.agent,
        model: req.body.model,
        llmTurn: req.app.get('siraCodeLlmTurn'),
        chip: req.body.chip || req.body.modality || req.body.generationLane || req.body.lane,
        attachments: req.body.attachments || req.body.files,
        permission: req.body.permission || req.body.toolPermission || req.body.composerPermission,
      });
      return res.json({ result });
    } catch (err) {
      return fail(res, err);
    }
  },
);

router.post(
  '/session/:id/agent',
  authenticateToken,
  [body('agent').isString().withMessage('agent is required').bail().trim().notEmpty()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const session = siraCode.switchAgent(req.params.id, req.body.agent, userIdOf(req));
      return res.json({ session });
    } catch (err) {
      return fail(res, err);
    }
  },
);

router.post('/session/:id/abort', authenticateToken, (req, res) => {
  try {
    const result = siraCode.abort(req.params.id, userIdOf(req));
    return res.json({ ok: true, result: result.session });
  } catch (err) {
    return fail(res, err);
  }
});

router.post(
  '/session/:id/permission',
  authenticateToken,
  [
    body('permissionId').isString().trim().notEmpty(),
    body('decision').isIn(['allow', 'deny']),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const result = siraCode.resolvePermission(
        req.params.id,
        req.body.permissionId,
        req.body.decision,
        userIdOf(req),
      );
      return res.json(result);
    } catch (err) {
      return fail(res, err);
    }
  },
);

router.get('/file', authenticateToken, async (req, res) => {
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : req.query.session;
  if (!rel) return res.status(400).json({ error: 'validation_failed', message: 'path is required' });
  if (!sessionId) return res.status(400).json({ error: 'validation_failed', message: 'sessionId is required' });
  try {
    const out = await siraCode.readFile(sessionId, rel, userIdOf(req));
    return res.json(out);
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/files', authenticateToken, async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : req.query.session;
  if (!sessionId) return res.status(400).json({ error: 'validation_failed', message: 'sessionId is required' });
  try {
    return res.json(await siraCode.listFiles(sessionId, userIdOf(req)));
  } catch (err) {
    return fail(res, err);
  }
});

const RUNNER_CTRL = process.env.CODE_RUNNER_URL || 'http://runner:4097';
const RUNNER_DEV_URL = process.env.CODE_RUNNER_DEV_URL || 'http://localhost:5173';

router.post('/run', authenticateToken, async (req, res) => {
  try {
    const r = await fetch(`${RUNNER_CTRL}/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(Number(process.env.RUNNER_CTRL_TIMEOUT_MS) || 10000),
    });
    const j = await r.json().catch(() => ({}));
    return res.json({ ...j, devUrl: RUNNER_DEV_URL });
  } catch (err) {
    return upstreamFail(res, err, 'runner_unreachable');
  }
});

router.get('/run/status', authenticateToken, async (req, res) => {
  try {
    const r = await fetch(`${RUNNER_CTRL}/status`, {
      signal: AbortSignal.timeout(Number(process.env.RUNNER_CTRL_TIMEOUT_MS) || 10000),
    });
    const j = await r.json().catch(() => ({}));
    return res.json({ ...j, devUrl: RUNNER_DEV_URL });
  } catch (err) {
    return upstreamFail(res, err, 'runner_unreachable');
  }
});

router.post('/run/stop', authenticateToken, async (req, res) => {
  try {
    await fetch(`${RUNNER_CTRL}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(Number(process.env.RUNNER_CTRL_TIMEOUT_MS) || 10000),
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    return upstreamFail(res, err, 'runner_unreachable');
  }
});

router.get('/events', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId;
  let unsubscribe = () => {};
  try {
    unsubscribe = siraCode.streamEvents(res, {
      sessionId: sessionId || undefined,
      userId: userIdOf(req),
      lastEventId,
    });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message || 'stream error' })}\n\n`);
    return res.end();
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    try { unsubscribe(); } catch { /* already closed */ }
  });
});

module.exports = router;
module.exports.upstreamFail = upstreamFail;
