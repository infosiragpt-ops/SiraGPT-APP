'use strict';

/**
 * agentes-coding route — AGENTES_CODING_V2 (Phase 1 health + Phase 2a sessions).
 *
 *   GET    /api/agentes-coding/health                 → { ok, enabled }  (public, always 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   POST   /api/agentes-coding/sessions               → createSession
 *   POST   /api/agentes-coding/sessions/:id/exec      → exec
 *   GET    /api/agentes-coding/sessions/:id/files     → listFiles
 *   GET    /api/agentes-coding/sessions/:id/map       → repo-map hints (Phase 3b)
 *   POST   /api/agentes-coding/sessions/:id/map       → repo-map hints (query body)
 *   POST   /api/agentes-coding/sessions/:id/struct-edit        → preview ast-grep diffs (Phase 3c)
 *   POST   /api/agentes-coding/sessions/:id/struct-edit/apply  → apply diffs via writeFile
 *   POST   /api/agentes-coding/sessions/:id/terminal           → open PTY-stub channel (Phase 3d)
 *   GET    /api/agentes-coding/sessions/:id/terminal/:channelId
 *   POST   /api/agentes-coding/sessions/:id/terminal/:channelId/input
 *   POST   /api/agentes-coding/sessions/:id/terminal/:channelId/resize
 *   POST   /api/agentes-coding/sessions/:id/terminal/:channelId/exec
 *   GET    /api/agentes-coding/sessions/:id/terminal/:channelId/stream  (SSE)
 *   DELETE /api/agentes-coding/sessions/:id/terminal/:channelId
 *   POST   /api/agentes-coding/sessions/:id/read      → readFile
 *   PUT    /api/agentes-coding/sessions/:id/files     → writeFile
 *   POST   /api/agentes-coding/sessions/:id/expose    → exposePort (stub)
 *   DELETE /api/agentes-coding/sessions/:id           → destroy
 *
 * Does not change default /agentes UX. IDE shell (Phase 3a) mounts
 * only when health.enabled. Phase 3d is API-only (UI-lock). See
 * docs/agentes-coding-terminal.md.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { isAgentesCodingV2Enabled } = require('../services/agentes-coding/flags');
const {
  createCodingSandbox,
  getDefaultSandbox,
  CodingSandboxError,
} = require('../services/agentes-coding/coding-sandbox');
const { fail } = require('../services/agentes-coding/coding-sandbox/errors');
const { mapForRequest } = require('../services/agentes-coding/repo-map');
const {
  previewForRequest,
  applyForRequest,
} = require('../services/agentes-coding/structural-edit');
const {
  createTerminalHub,
  createSseTransport,
  attachTerminalWebSocket,
  WS_PATH,
} = require('../services/agentes-coding/terminal');

function createAgentesCodingRouter(opts = {}) {
  const env = opts.env || process.env;
  const sandbox = opts.sandbox || null;
  const getSandbox = () => sandbox || getDefaultSandbox();
  const structRunner = opts.sgRunner || opts.structuralEditRunner || null;
  const authenticate = opts.authenticate || authenticateToken;
  const hub = opts.terminalHub || createTerminalHub({ env, sandbox: getSandbox() });

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

  function acceptQueryToken(req, _res, next) {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${String(req.query.token)}`;
    }
    return next();
  }

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
  router.post('/sessions', authenticate, async (req, res) => {
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
  router.post('/sessions/:id/exec', authenticate, async (req, res) => {
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
  router.get('/sessions/:id/files', authenticate, async (req, res) => {
    try {
      const files = await getSandbox().listFiles(req.params.id, req.query.path || '.');
      return res.json({ ok: true, files });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  async function handleRepoMap(req, res) {
    try {
      const src = { ...(req.query || {}), ...(req.body || {}) };
      const result = await mapForRequest(getSandbox(), req.params.id, {
        query: src.query,
        limit: src.limit,
        maxFiles: src.maxFiles,
        path: src.path,
      }, env);
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  }

  /**
   * Ranked file/symbol hints (Aider-pattern repo-map). Header-only.
   */
  router.get('/sessions/:id/map', authenticate, handleRepoMap);
  router.post('/sessions/:id/map', authenticate, handleRepoMap);

  /**
   * ast-grep pattern preview (proposed diffs). Never writes.
   */
  router.post('/sessions/:id/struct-edit', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await previewForRequest(getSandbox(), req.params.id, {
        pattern: body.pattern,
        rewrite: body.rewrite,
        lang: body.lang,
        path: body.path,
        paths: body.paths,
        file: body.file,
        maxFiles: body.maxFiles,
        timeoutMs: body.timeoutMs,
      }, env, { runner: structRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Apply proposed diffs through sandbox.writeFile (path jail).
   */
  router.post('/sessions/:id/struct-edit/apply', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await applyForRequest(getSandbox(), req.params.id, {
        diffs: body.diffs,
        pattern: body.pattern,
        rewrite: body.rewrite,
        lang: body.lang,
        path: body.path,
        paths: body.paths,
        file: body.file,
        maxFiles: body.maxFiles,
        timeoutMs: body.timeoutMs,
      }, env, { runner: structRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Open a PTY-stub terminal channel (API-only; UI-lock keeps the HTTP stub).
   */
  router.post('/sessions/:id/terminal', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const channel = await hub.open({
        sessionId: req.params.id,
        cwd: body.cwd,
        cols: body.cols,
        rows: body.rows,
      });
      return res.status(201).json({
        ok: true,
        channel,
        wsPath: `${WS_PATH}?channelId=${encodeURIComponent(channel.channelId)}`,
        ssePath: `/api/agentes-coding/sessions/${encodeURIComponent(req.params.id)}/terminal/${encodeURIComponent(channel.channelId)}/stream`,
      });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/terminal/:channelId', authenticate, async (req, res) => {
    try {
      const channel = hub.snapshot(req.params.channelId);
      if (channel.sessionId !== req.params.id) failSessionMismatch();
      return res.json({ ok: true, channel });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post('/sessions/:id/terminal/:channelId/input', authenticate, async (req, res) => {
    try {
      const channel = hub.get(req.params.channelId);
      if (channel.sessionId !== req.params.id) failSessionMismatch();
      const snap = await channel.receiveInput(req.body && req.body.data);
      return res.json({ ok: true, channel: snap });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post('/sessions/:id/terminal/:channelId/resize', authenticate, async (req, res) => {
    try {
      const channel = hub.get(req.params.channelId);
      if (channel.sessionId !== req.params.id) failSessionMismatch();
      const snap = channel.resize(req.body && req.body.cols, req.body && req.body.rows);
      return res.json({ ok: true, channel: snap });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post('/sessions/:id/terminal/:channelId/exec', authenticate, async (req, res) => {
    try {
      const channel = hub.get(req.params.channelId);
      if (channel.sessionId !== req.params.id) failSessionMismatch();
      const snap = await channel.runCommand(req.body && req.body.command, {
        cwd: req.body && req.body.cwd,
        timeoutMs: req.body && req.body.timeoutMs,
      });
      return res.json({ ok: true, channel: snap });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get(
    '/sessions/:id/terminal/:channelId/stream',
    acceptQueryToken,
    authenticate,
    (req, res) => {
      try {
        const channel = hub.get(req.params.channelId);
        if (channel.sessionId !== req.params.id) failSessionMismatch();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Connection: 'keep-alive',
        });
        const transport = createSseTransport(res);
        channel.attach(transport);
        req.on('close', () => channel.detach(transport));
      } catch (err) {
        return sendSandboxError(res, err);
      }
      return undefined;
    },
  );

  router.delete('/sessions/:id/terminal/:channelId', authenticate, async (req, res) => {
    try {
      const channel = hub.get(req.params.channelId);
      if (channel.sessionId !== req.params.id) failSessionMismatch();
      const snap = hub.close(req.params.channelId);
      return res.json({ ok: true, channel: snap });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  function failSessionMismatch() {
    fail('E_SESSION_NOT_FOUND', 'El canal no pertenece a esta sesión.');
  }

  /**
   * Read one file (JSON body to avoid path-in-URL traversal).
   */
  router.post('/sessions/:id/read', authenticate, async (req, res) => {
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
  router.put('/sessions/:id/files', authenticate, async (req, res) => {
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
  router.post('/sessions/:id/expose', authenticate, async (req, res) => {
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
  router.delete('/sessions/:id', authenticate, async (req, res) => {
    try {
      hub.closeSession(req.params.id);
      const out = await getSandbox().destroy(req.params.id);
      return res.json(out);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.use((_req, res) => {
    return res.status(404).json({ error: 'not_found' });
  });

  router.attachTerminalWebSocket = (httpServer, extra = {}) => attachTerminalWebSocket(httpServer, {
    hub,
    env,
    ...extra,
  });

  return router;
}

const defaultRouter = createAgentesCodingRouter();
module.exports = defaultRouter;
module.exports.createAgentesCodingRouter = createAgentesCodingRouter;
module.exports.createCodingSandbox = createCodingSandbox;
module.exports.attachTerminalWebSocket = (httpServer, extra = {}) => {
  if (typeof defaultRouter.attachTerminalWebSocket === 'function') {
    return defaultRouter.attachTerminalWebSocket(httpServer, extra);
  }
  return attachTerminalWebSocket(httpServer, extra);
};
