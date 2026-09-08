'use strict';

/**
 * agentes-coding route — AGENTES_CODING_V2 (Phase 1 health + Phase 2a sessions).
 *
 *   GET    /api/agentes-coding/health                 → { ok, enabled }  (public, always 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   POST   /api/agentes-coding/sessions               → createSession
 *   POST   /api/agentes-coding/sessions/:id/exec      → exec
 *   GET    /api/agentes-coding/sessions/:id/files     → listFiles
 *   POST   /api/agentes-coding/sessions/:id/read      → readFile
 *   PUT    /api/agentes-coding/sessions/:id/files     → writeFile
 *   POST   /api/agentes-coding/sessions/:id/expose    → exposePort (stub)
 *   DELETE /api/agentes-coding/sessions/:id           → destroy
 *
 * Does not change default /agentes UX. IDE shell (Phase 3a) mounts
 * only when health.enabled. See docs/agentes-coding-ide.md.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');
const {
  createCodingSandbox,
  getDefaultSandbox,
  CodingSandboxError,
} = require('../services/agentes-coding/coding-sandbox');

function createAgentesCodingRouter(opts = {}) {
  const env = opts.env || process.env;
  const sandbox = opts.sandbox || null;
  const getSandbox = () => sandbox || getDefaultSandbox();

  const router = express.Router();

  function enabled() {
    return isAgentesCodingV2Enabled(env);
  }

  router.get('/health', (_req, res) => {
    const payload = JSON.stringify({ ok: true, enabled: enabled() });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(payload);
  });

  router.use((req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'not_found' });
    return next();
  });

  function sendSandboxError(res, err) {
    if (err instanceof CodingSandboxError) {
      return res.status(err.status).json(err.toJSON());
    }
    return res.status(500).json({
      error: 'E_PROVIDER',
      message: 'Error interno del sandbox.',
    });
  }

  /**
   * Create a coding-sandbox session (flag on).
   */
  router.post('/sessions', authenticateToken, async (req, res) => {
    try {
      const body = req.body || {};
      const session = await getSandbox().createSession({
        userId: req.user && req.user.id ? req.user.id : null,
        ttlMs: body.ttlMs,
        networkAllowlist: body.networkAllowlist,
        cpus: body.cpus,
        memory: body.memory,
        pids: body.pids,
      });
      return res.status(201).json({ ok: true, session });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Exec a command inside the session workspace.
   */
  router.post('/sessions/:id/exec', authenticateToken, async (req, res) => {
    try {
      const result = await getSandbox().exec(req.params.id, req.body && req.body.command, {
        timeoutMs: req.body && req.body.timeoutMs,
        cwd: req.body && req.body.cwd,
      });
      return res.json({ ok: result.ok, result });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * List files in the session workspace.
   */
  router.get('/sessions/:id/files', authenticateToken, async (req, res) => {
    try {
      const files = await getSandbox().listFiles(req.params.id, req.query.path || '.');
      return res.json({ ok: true, files });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Read one file (JSON body to avoid path-in-URL traversal).
   */
  router.post('/sessions/:id/read', authenticateToken, async (req, res) => {
    try {
      const buf = await getSandbox().readFile(req.params.id, req.body && req.body.path);
      return res.json({
        ok: true,
        path: req.body && req.body.path,
        content: buf.toString('utf8'),
        bytes: buf.length,
      });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Write one file into the session workspace.
   */
  router.put('/sessions/:id/files', authenticateToken, async (req, res) => {
    try {
      const written = await getSandbox().writeFile(
        req.params.id,
        req.body && req.body.path,
        req.body && req.body.content,
      );
      return res.json({ ok: true, file: written });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Optional preview-port stub (deny-by-default).
   */
  router.post('/sessions/:id/expose', authenticateToken, async (req, res) => {
    try {
      const exposed = await getSandbox().exposePort(req.params.id, req.body && req.body.port);
      return res.json({ ok: true, exposed });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Destroy the session and its container.
   */
  router.delete('/sessions/:id', authenticateToken, async (req, res) => {
    try {
      const out = await getSandbox().destroy(req.params.id);
      return res.json(out);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.use((_req, res) => {
    return res.status(404).json({ error: 'not_found' });
  });

  return router;
}

module.exports = createAgentesCodingRouter();
module.exports.createAgentesCodingRouter = createAgentesCodingRouter;
module.exports.createCodingSandbox = createCodingSandbox;
