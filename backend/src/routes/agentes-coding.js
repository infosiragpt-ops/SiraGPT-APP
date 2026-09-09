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
 *   POST   /api/agentes-coding/sessions/:id/expose    → exposePort
 *   POST   /api/agentes-coding/sessions/:id/preview   → exposePort (signed URL)
 *   GET    /api/agentes-coding/sessions/:id/preview   → list exposed ports
 *   GET    /api/agentes-coding/sessions/:id/preview/:token → resolve signed preview
 *   DELETE /api/agentes-coding/sessions/:id/preview/:port  → unexpose
 *   GET|POST|DELETE /api/agentes-coding/sessions/:id/ports[/:port]
 *   POST   /api/agentes-coding/sessions/:id/git/init         → git init (Phase 3f)
 *   GET    /api/agentes-coding/sessions/:id/git/status
 *   GET    /api/agentes-coding/sessions/:id/git/diff
 *   POST   /api/agentes-coding/sessions/:id/git/checkpoint
 *   GET    /api/agentes-coding/sessions/:id/git/checkpoints
 *   GET    /api/agentes-coding/sessions/:id/git/checkpoints/:sha
 *   POST   /api/agentes-coding/sessions/:id/export            → zip/tar.gz (Phase 3g)
 *   GET    /api/agentes-coding/sessions/:id/export
 *   GET    /api/agentes-coding/sessions/:id/export/:exportId
 *   POST   /api/agentes-coding/sessions/:id/deploy            → Coolify/Dokploy stub
 *   GET    /api/agentes-coding/sessions/:id/deploy
 *   GET    /api/agentes-coding/sessions/:id/deploy/:deployId
 *   POST   /api/agentes-coding/sessions/:id/harness/run       → Phase 4a tool loop (+ 4c jobs)
 *   GET    /api/agentes-coding/sessions/:id/harness
 *   GET    /api/agentes-coding/sessions/:id/harness/:runId
 *   POST   /api/agentes-coding/sessions/:id/harness/:runId/cancel
 *   GET    /api/agentes-coding/sessions/:id/harness/:runId/permissions
 *   POST   /api/agentes-coding/sessions/:id/harness/:runId/permissions/:permissionId/resolve
 *   DELETE /api/agentes-coding/sessions/:id           → destroy
 *
 * Does not change default /agentes UX. IDE shell (Phase 3a) mounts
 * only when health.enabled. Phase 3d/3e/3f/3g are API-only (UI-lock). See
 * docs/agentes-coding-terminal.md, docs/agentes-coding-preview.md,
 * docs/agentes-coding-git.md, docs/agentes-coding-export-deploy.md,
 * docs/agentes-coding-harness.md, docs/agentes-coding-permissions.md
 * and docs/agentes-coding-jobs.md.
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
const { renderPreviewStub } = require('../services/agentes-coding/preview');
const sessionGit = require('../services/agentes-coding/git');
const sessionExport = require('../services/agentes-coding/export');
const sessionDeploy = require('../services/agentes-coding/deploy');
const sessionHarness = require('../services/agentes-coding/harness');

function createAgentesCodingRouter(opts = {}) {
  const env = opts.env || process.env;
  const sandbox = opts.sandbox || null;
  const getSandbox = () => sandbox || getDefaultSandbox();
  const structRunner = opts.sgRunner || opts.structuralEditRunner || null;
  const authenticateIdentity = opts.authenticate || authenticateToken;
  const hub = opts.terminalHub || createTerminalHub({ env, sandbox: getSandbox() });
  const gitRunner = opts.gitRunner || opts.git || null;
  const deployHttp = opts.deployHttp || opts.httpClient || opts.fetchImpl || null;
  const harnessLlm = opts.harnessLlm || opts.llmTurn || null;
  const harnessPermissionPolicy = opts.harnessPermissionPolicy || opts.permissionPolicy || null;
  const harnessJobs = opts.harnessJobs || opts.jobs || null;

  const router = express.Router();

  function authenticate(req, res, next) {
    return authenticateIdentity(req, res, () => {
      if (typeof req.user?.id !== 'string' || !req.user.id.trim()) {
        return res.status(401).json({ error: 'access_token_required' });
      }
      try {
        if (req.params.id) getSandbox().assertSessionOwner(req.params.id, req.user.id);
        return next();
      } catch (err) {
        return sendSandboxError(res, err);
      }
    });
  }

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
        previewPorts: body.previewPorts || body.portAllowlist,
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
   * Preview port (deny-by-default). Signed ephemeral URL + localhost metadata.
   */
  async function handleExposePort(req, res) {
    try {
      const exposed = await getSandbox().exposePort(req.params.id, req.body && req.body.port);
      return res.status(201).json({ ok: true, exposed, preview: exposed });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  }

  async function handleListPorts(req, res) {
    try {
      const ports = await getSandbox().listPorts(req.params.id);
      return res.json({ ok: true, ports });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  }

  async function handleUnexposePort(req, res) {
    try {
      const out = await getSandbox().unexposePort(req.params.id, req.params.port);
      return res.json(out);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  }

  router.post('/sessions/:id/expose', authenticate, handleExposePort);
  router.post('/sessions/:id/preview', authenticate, handleExposePort);
  router.get('/sessions/:id/preview', authenticate, handleListPorts);
  router.get('/sessions/:id/ports', authenticate, handleListPorts);
  router.post('/sessions/:id/ports', authenticate, handleExposePort);
  router.delete('/sessions/:id/preview/:port', authenticate, handleUnexposePort);
  router.delete('/sessions/:id/ports/:port', authenticate, handleUnexposePort);

  /**
   * Resolve a signed preview token. The token is the credential (iframe-ready).
   * Flag-off still 404s via the router gate. JSON default; HTML stub on Accept.
   */
  router.get('/sessions/:id/preview/:token', async (req, res) => {
    try {
      const preview = await getSandbox().resolvePreview(req.params.id, req.params.token);
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(renderPreviewStub(preview));
        return undefined;
      }
      return res.json({ ok: true, preview });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Per-session git (Phase 3f). API-only; UI-lock unchanged.
   */
  router.post('/sessions/:id/git/init', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await sessionGit.initForRequest(getSandbox(), req.params.id, {
        branch: body.branch,
        runner: gitRunner,
      }, env, { runner: gitRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/git/status', authenticate, async (req, res) => {
    try {
      const result = await sessionGit.statusForRequest(getSandbox(), req.params.id, {
        runner: gitRunner,
      }, env, { runner: gitRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/git/diff', authenticate, async (req, res) => {
    try {
      const src = { ...(req.query || {}), ...(req.body || {}) };
      const result = await sessionGit.diffForRequest(getSandbox(), req.params.id, {
        path: src.path,
        from: src.from,
        to: src.to,
        runner: gitRunner,
      }, env, { runner: gitRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post('/sessions/:id/git/checkpoint', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await sessionGit.checkpointForRequest(getSandbox(), req.params.id, {
        message: body.message,
        runner: gitRunner,
      }, env, { runner: gitRunner });
      return res.status(201).json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/git/checkpoints', authenticate, async (req, res) => {
    try {
      const result = await sessionGit.listForRequest(getSandbox(), req.params.id, {
        limit: req.query && req.query.limit,
        runner: gitRunner,
      }, env, { runner: gitRunner });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/git/checkpoints/:sha', authenticate, async (req, res) => {
    try {
      const result = await sessionGit.getForRequest(
        getSandbox(),
        req.params.id,
        req.params.sha,
        { runner: gitRunner },
        env,
        { runner: gitRunner },
      );
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Session workspace export (Phase 3g). API-only; UI-lock unchanged.
   */
  router.post('/sessions/:id/export', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await sessionExport.exportForRequest(getSandbox(), req.params.id, {
        format: body.format,
        path: body.path,
        includeBytes: body.includeBytes === true,
      }, env);
      return res.status(201).json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/export', authenticate, async (req, res) => {
    try {
      const result = await sessionExport.listForRequest(getSandbox(), req.params.id, env);
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/export/:exportId', authenticate, async (req, res) => {
    try {
      const download = req.query && (req.query.download === '1' || req.query.download === 'true');
      const result = await sessionExport.getForRequest(
        getSandbox(),
        req.params.id,
        req.params.exportId,
        { raw: download === true, includeBytes: false },
        env,
      );
      if (download && result.buffer) {
        res.writeHead(200, {
          'Content-Type': result.export.mime || 'application/octet-stream',
          'Content-Length': String(result.buffer.length),
          'Content-Disposition': `attachment; filename="${result.export.id}.${result.export.format === 'tar.gz' ? 'tar.gz' : 'zip'}"`,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(result.buffer);
        return undefined;
      }
      return res.json({ ok: true, export: result.export });
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Deploy stub (Phase 3g). Coolify/Dokploy only via injectable client + allowlist.
   */
  router.post('/sessions/:id/deploy', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await sessionDeploy.deployForRequest(getSandbox(), req.params.id, {
        provider: body.provider,
        name: body.name || body.app || body.project,
        appId: body.appId || body.uuid || body.applicationId,
        baseUrl: body.baseUrl,
        live: body.live,
        timeoutMs: body.timeoutMs,
      }, env, { httpClient: deployHttp });
      return res.status(201).json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/deploy', authenticate, async (req, res) => {
    try {
      const result = await sessionDeploy.listForRequest(getSandbox(), req.params.id, env);
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/deploy/:deployId', authenticate, async (req, res) => {
    try {
      const result = await sessionDeploy.getForRequest(
        getSandbox(),
        req.params.id,
        req.params.deployId,
        env,
      );
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * Session harness (Phase 4a + 4d). API-only; injectable LLM wins;
   * otherwise the flag-on adapter in harness/llm.js. Sandbox jail only.
   */
  router.post('/sessions/:id/harness/run', authenticate, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await sessionHarness.runForRequest(getSandbox(), req.params.id, {
        prompt: body.prompt || body.text || body.message,
        maxSteps: body.maxSteps,
        maxTokens: body.maxTokens,
        timeoutMs: body.timeoutMs,
        modelAlias: body.modelAlias || body.alias,
      }, env, { llmTurn: harnessLlm, permissionPolicy: harnessPermissionPolicy, jobs: harnessJobs });
      return res.status(201).json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/harness', authenticate, async (req, res) => {
    try {
      const result = await sessionHarness.listForRequest(getSandbox(), req.params.id, env, { jobs: harnessJobs });
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.get('/sessions/:id/harness/:runId', authenticate, async (req, res) => {
    try {
      const result = await sessionHarness.getForRequest(
        getSandbox(),
        req.params.id,
        req.params.runId,
        env,
        { jobs: harnessJobs },
      );
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post('/sessions/:id/harness/:runId/cancel', authenticate, async (req, res) => {
    try {
      const result = await sessionHarness.cancelForRequest(
        getSandbox(),
        req.params.id,
        req.params.runId,
        env,
        { jobs: harnessJobs },
      );
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  /**
   * HITL permissions (Phase 4b). Cline ask/once/always/reject pattern.
   * API-only; injectable policy; in-process store.
   */
  router.get('/sessions/:id/harness/:runId/permissions', authenticate, async (req, res) => {
    try {
      const result = await sessionHarness.listPermissionsForRequest(
        getSandbox(),
        req.params.id,
        req.params.runId,
        env,
        { jobs: harnessJobs },
      );
      return res.json(result);
    } catch (err) {
      return sendSandboxError(res, err);
    }
  });

  router.post(
    '/sessions/:id/harness/:runId/permissions/:permissionId/resolve',
    authenticate,
    async (req, res) => {
      try {
        const body = req.body || {};
        const result = await sessionHarness.resolveForRequest(
          getSandbox(),
          req.params.id,
          req.params.runId,
          req.params.permissionId,
          body.decision || body.reply,
          env,
          { permissionPolicy: harnessPermissionPolicy, jobs: harnessJobs, llmTurn: harnessLlm },
        );
        return res.json(result);
      } catch (err) {
        return sendSandboxError(res, err);
      }
    },
  );

  /**
   * Destroy the session and its container.
   */
  router.delete('/sessions/:id', authenticate, async (req, res) => {
    try {
      hub.closeSession(req.params.id);
      sessionGit.forget(getSandbox(), req.params.id);
      sessionExport.forget(getSandbox(), req.params.id);
      sessionDeploy.forget(getSandbox(), req.params.id);
      await sessionHarness.forgetSession(getSandbox(), req.params.id, harnessJobs);
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
