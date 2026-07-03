'use strict';

/**
 * codex route — Codex Agent V2 (spec docs/codex-agent-ux.md, flag CODEX_AGENT_V2).
 *
 *   GET  /api/codex/health                       → { ok, enabled }   (público, SIEMPRE 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   POST /api/codex/projects                     → crea + provisiona  (auth)
 *   GET  /api/codex/projects                     → lista del usuario  (auth)
 *   GET  /api/codex/projects/:id                 → detalle            (auth)
 *   POST /api/codex/projects/:id/preview/start   → dev server on      (auth)
 *   GET  /api/codex/projects/:id/preview/status  → estado del runner  (auth)
 *   POST /api/codex/projects/:id/export          → mirror src a disco  (auth)
 *   POST /api/codex/projects/:id/preview/stop    → dev server off     (auth)
 *   GET  /api/codex/projects/:id/files           → lista de archivos  (auth)
 *   GET  /api/codex/projects/:id/file?path=      → contenido archivo  (auth)
 *
 * Montaje: en backend/index.js DESPUÉS del router legacy codex-runs (que ya
 * ocupa POST /api/codex/runs y GET /api/codex/runs/:id). Para no sombrear ese
 * flujo en ningún estado del flag, las corridas V2 viven scoped por proyecto
 * (/projects/:id/runs, fase F2) — decisión registrada en docs/codex-agent-ux.md.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isCodexV2Enabled } = require('../services/codex/flags');
const { canUseCodexAgent, publicAccess } = require('../services/codex/access-control');
const projectService = require('../services/codex/project-service');
const { createRunnerClient, runnerDevUrl, codexExportHostPath } = require('../services/codex/runner-client');
const eventStore = require('../services/codex/event-store');
const runAccess = require('../services/codex/run-access');
const pubsub = require('../services/codex/redis-pubsub');
const runService = require('../services/codex/run-service');
const checkpointService = require('../services/codex/checkpoint-service');
const {
  STRIP_REQUEST_HEADERS,
  HOP_BY_HOP_HEADERS,
} = require('../utils/proxy-headers');

const router = express.Router();

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPreviewPayload(payload, env = process.env) {
  const secret = env.CODEX_PREVIEW_TOKEN_SECRET || env.JWT_SECRET || env.SESSION_SECRET || 'codex-preview-dev-secret';
  const body = base64urlJson(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPreviewToken(token, env = process.env) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const secret = env.CODEX_PREVIEW_TOKEN_SECRET || env.JWT_SECRET || env.SESSION_SECRET || 'codex-preview-dev-secret';
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function previewTokenFor({ projectId, userId }, env = process.env) {
  return signPreviewPayload({
    projectId,
    userId,
    exp: Date.now() + (Number(env.CODEX_PREVIEW_TOKEN_TTL_MS) || 6 * 60 * 60 * 1000),
  }, env);
}

function codexPreviewBasePath(projectId, token) {
  return `/api/codex/projects/${encodeURIComponent(projectId)}/preview/${encodeURIComponent(token)}/app/`;
}

function codexPreviewInternalUrl(env = process.env, port = null) {
  const base = String(env.CODE_RUNNER_DEV_INTERNAL_URL || env.CODE_RUNNER_DEV_URL || runnerDevUrl(env)).replace(/\/+$/, '');
  if (port == null) return base;
  try {
    const u = new URL(base);
    u.port = String(port);
    return u.toString().replace(/\/+$/, '');
  } catch {
    return base;
  }
}

// ── Per-project dev-server port (multi-project runner, audit B1) ────────────
// The runner assigns each project a port from its pool; the preview proxy must
// target the right one. Short-TTL cache so the proxy doesn't hit the runner's
// control API for every asset request. Primed on preview/start, invalidated on
// stop; a stale hit self-heals within the TTL (the runner keeps a project's
// port stable across restarts — it only changes after a pool evict).
const previewPortCache = new Map(); // projectId -> { port, ts }
function previewPortTtlMs(env = process.env) {
  return Math.max(500, Number(env.CODEX_PREVIEW_PORT_TTL_MS) || 3000);
}

async function resolvePreviewPort(projectId, env = process.env) {
  const hit = previewPortCache.get(projectId);
  if (hit && Date.now() - hit.ts < previewPortTtlMs(env)) return hit.port;
  try {
    const st = await createRunnerClient().devStatus(projectId);
    const port = st && st.running && Number.isInteger(st.port) ? st.port : null;
    previewPortCache.set(projectId, { port, ts: Date.now() });
    return port;
  } catch {
    // Runner unreachable → keep whatever we knew (null → legacy base URL).
    return hit ? hit.port : null;
  }
}

function previewProxyHostHeader(upstreamBase, env = process.env) {
  const configured = String(env.CODE_RUNNER_DEV_PROXY_HOST_HEADER || '').trim();
  if (configured) return configured;
  const port = upstreamBase.port || (upstreamBase.protocol === 'https:' ? '443' : '80');
  // Vite 7 rejects service-discovery hosts such as "runner" by default. The
  // TCP target can still be runner:5173, but the HTTP Host header must be a
  // loopback host Vite allows.
  if (/^(runner|code-runner)$/i.test(upstreamBase.hostname)) return `localhost:${port}`;
  return upstreamBase.host;
}

function requireCodexAgentAccess(req, res, next) {
  if (canUseCodexAgent(req.user, process.env)) return next();
  return res.status(403).json({ error: 'codex_forbidden', message: 'Tu cuenta no puede ejecutar APPS en producción.' });
}

function applyPreviewFrameHeaders(_req, res, next) {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  next();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunnerPreviewReady(runner, projectId, env = process.env) {
  const timeoutMs = Math.max(1000, Number(env.CODEX_PREVIEW_START_TIMEOUT_MS) || 90_000);
  const intervalMs = Math.max(250, Number(env.CODEX_PREVIEW_START_POLL_MS) || 1000);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;

  while (Date.now() < deadline) {
    lastStatus = await runner.devStatus(projectId);
    const sameProject = !lastStatus.project || lastStatus.project === projectId;
    if (lastStatus.ready && sameProject) return lastStatus;
    if (lastStatus.error && lastStatus.running === false) throw new Error(lastStatus.error);
    await sleep(intervalMs);
  }

  const tail = Array.isArray(lastStatus?.tail) ? lastStatus.tail.slice(-3).join(' | ') : '';
  const detail = lastStatus?.error || tail || 'El preview no quedo listo a tiempo.';
  throw new Error(detail);
}

// EventSource can't set headers, so allow a ?token= fallback for the SSE route
// (header still wins). Same shape as the goals SSE route.
function bearerFromQueryFallback(req, _res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    const token = String(req.query.token);
    if (token.length > 0 && token.length < 8192) {
      req.headers.authorization = `Bearer ${token}`;
    }
  }
  next();
}

// Público y SIEMPRE 200: el frontend decide si renderiza la UI V2 con esto.
// NUNCA cachear: el flag puede cambiar y un 304 con cuerpo viejo (enabled:false)
// dejaría la UI clavada en el flujo antiguo aunque el flag ya esté on. Sin ETag
// + no-store ⇒ el navegador siempre recibe el valor fresco.
router.get('/health', (_req, res) => {
  // res.end (not res.json) so Express never attaches an ETag → a conditional
  // request can't get a 304 with a stale body. Paired with no-store this makes
  // the flag value impossible to cache.
  const body = JSON.stringify({ ok: true, enabled: isCodexV2Enabled() });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(body);
});

router.get('/access', authenticateToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, enabled: isCodexV2Enabled(), ...publicAccess(req.user, process.env) });
});

router.use((req, res, next) => {
  if (!isCodexV2Enabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

// Agent SDK catalogue: the specialists the APPS agent can delegate to via
// run_subagent, plus the LLM currently serving the loop (for observability).
router.get('/agents', authenticateToken, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // eslint-disable-next-line global-require
    const sdk = require('../services/codex/agent-sdk');
    // eslint-disable-next-line global-require
    const llmProvider = require('../services/codex/llm-provider');
    return res.json({
      ok: true,
      agents: sdk.listSubagents(),
      llm: llmProvider.describeActiveProvider(),
      custom: {
        supported: true,
        path: sdk.CUSTOM_AGENTS_PATH,
        allowedTools: sdk.allowedCustomTools(),
        note: 'Define agentes propios del proyecto en este archivo del workspace: [{ name, description, prompt, tools?, maxSteps? }].',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'codex_agents_failed', message: err.message });
  }
});

router.post(
  '/projects',
  authenticateToken,
  requireCodexAgentAccess,
  [body('name').isString().withMessage('name must be a string').bail().trim().isLength({ min: 1, max: 80 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const project = await projectService.createProject({
        userId: req.user.id,
        name: req.body.name.trim(),
        brief: req.body.brief ?? null,
      });
      return res.status(201).json({ project });
    } catch (err) {
      return res.status(500).json({ error: 'codex_create_failed', message: err.message });
    }
  },
);

router.get('/projects', authenticateToken, async (req, res) => {
  try {
    return res.json({ projects: await projectService.listProjects({ userId: req.user.id }) });
  } catch (err) {
    return res.status(500).json({ error: 'codex_list_failed', message: err.message });
  }
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  try {
    const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
    if (!project) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ project });
  } catch (err) {
    return res.status(500).json({ error: 'codex_get_failed', message: err.message });
  }
});

// Ownership gate compartido por las rutas de preview.
async function loadOwnedProject(req, res) {
  const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
  if (!project) {
    res.status(404).json({ error: 'project_not_found' });
    return null;
  }
  return project;
}

router.post('/projects/:id/preview/start', authenticateToken, async (req, res) => {
  try {
    if (!canUseCodexAgent(req.user, process.env)) {
      return res.status(403).json({ error: 'codex_forbidden', message: 'Tu cuenta no puede ejecutar APPS en producción.' });
    }
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const token = previewTokenFor({ projectId: project.id, userId: req.user.id });
    const basePath = codexPreviewBasePath(project.id, token);
    const runner = createRunnerClient();
    const out = await runner.startDev(project.id, { basePath });
    if (Number.isInteger(out?.port)) {
      previewPortCache.set(project.id, { port: out.port, ts: Date.now() });
    }
    const previewStatus = await waitForRunnerPreviewReady(runner, project.id);
    return res.json({ ...out, previewStatus, devUrl: basePath, previewUrl: basePath, basePath });
  } catch (err) {
    // Pool full and nothing evictable in the runner → surface as 429, not 502.
    if (err && (err.status === 429 || err.body?.error === 'dev_pool_exhausted')) {
      return res.status(429).json({
        error: 'dev_pool_exhausted',
        message: 'Todos los slots de preview están ocupados arrancando. Intenta de nuevo en unos segundos.',
      });
    }
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:id/preview/status', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().devStatus(project.id);
    return res.json({ ...out, devUrl: runnerDevUrl(process.env, Number.isInteger(out?.port) ? out.port : null) });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/preview/stop', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    await createRunnerClient().stopDev(project.id);
    previewPortCache.delete(project.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

// Hybrid "export to disk": mirror the project's source to the runner's
// host-bind-mounted EXPORT_DIR so it shows up in a real folder on the user's
// machine. Also fired best-effort after each checkpoint; this route lets the
// user force a fresh mirror and learn the host path.
router.post('/projects/:id/export', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().exportWorkspace(project.id);
    return res.json({ ...out, hostPath: codexExportHostPath(project.id) });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.use('/projects/:id/preview/:token/app', applyPreviewFrameHeaders, async (req, res) => {
  const payload = verifyPreviewToken(req.params.token);
  if (!payload || payload.projectId !== req.params.id) return res.status(403).json({ error: 'forbidden' });

  // Multi-project runner: target the port assigned to THIS project. Null
  // (unknown/not running) falls back to the configured base URL (legacy 5173).
  const projectPort = await resolvePreviewPort(req.params.id);

  let upstreamBase;
  try {
    upstreamBase = new URL(codexPreviewInternalUrl(process.env, projectPort));
  } catch {
    return res.status(502).json({ error: 'runner_unreachable', message: 'Preview interno no configurado.' });
  }

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk) || HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk === 'host' || lk === 'content-length') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders.host = previewProxyHostHeader(upstreamBase);

  const transport = upstreamBase.protocol === 'https:' ? https : http;
  const upstream = transport.request(
    {
      protocol: upstreamBase.protocol,
      hostname: upstreamBase.hostname,
      port: upstreamBase.port || (upstreamBase.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.originalUrl || req.url || '/',
      headers: fwdHeaders,
    },
    (up) => {
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'set-cookie' || HOP_BY_HOP_HEADERS.has(lk)) continue;
        if (lk === 'content-security-policy' || lk === 'x-frame-options') continue;
        if (lk.startsWith('access-control-')) continue;
        headers[k] = v;
      }
      headers['cache-control'] = 'no-store';
      headers['x-frame-options'] = 'SAMEORIGIN';
      headers['content-security-policy'] = "frame-ancestors 'self'";
      headers['referrer-policy'] = 'no-referrer';
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'runner_unreachable', message: 'El preview no respondió.' });
    else {
      try { res.end(); } catch (_) { /* already closed */ }
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
});

// ── Workspace files (desktop "Código" pane) ─────────────────────────────────
// List the project's source files (tracked + untracked, excluding gitignored —
// so node_modules never shows up) and read one file's content, both via the
// runner (the only process with filesystem access). Read-only.
router.get('/projects/:id/files', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().exec(project.id, ['git', 'ls-files', '-co', '--exclude-standard']);
    const files = String(out?.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    return res.json({ files });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

// ── Workspace import (browser → Codex project) ─────────────────────────────
// The /code chat keeps its own in-browser workspace; before an iterate run the
// frontend pushes those files here so the agent edits the SAME tree the user
// sees (audit 3.1-ALTA: without this, iterate edited a stale starter project
// and then overwrote the local workspace with it). The runner sidecar already
// rejects path traversal (resolveProjectRelPath), so this route only enforces
// auth/ownership, payload budgets, and the no-active-run invariant.
const IMPORT_MAX_FILES = 200;
const IMPORT_MAX_PATH_CHARS = 500;
const IMPORT_MAX_CONTENT_BYTES = 500 * 1024; // 500KB per file
const IMPORT_MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB per request

const importFilesValidators = [
  body('files')
    .isArray({ min: 1, max: IMPORT_MAX_FILES })
    .withMessage(`files must be an array of 1-${IMPORT_MAX_FILES} items`),
  body('files.*.path')
    .isString()
    .withMessage('path must be a string')
    .bail()
    .isLength({ min: 1, max: IMPORT_MAX_PATH_CHARS })
    .withMessage(`path must be 1-${IMPORT_MAX_PATH_CHARS} chars`),
  body('files.*.content')
    .isString()
    .withMessage('content must be a string')
    .bail()
    .custom((content) => {
      if (Buffer.byteLength(content, 'utf8') > IMPORT_MAX_CONTENT_BYTES) {
        throw new Error(`each file content must be <= ${IMPORT_MAX_CONTENT_BYTES} bytes`);
      }
      return true;
    }),
  body('files').custom((files) => {
    if (!Array.isArray(files)) return true; // isArray above already flags it
    const total = files.reduce(
      (sum, f) => sum + (typeof f?.content === 'string' ? Buffer.byteLength(f.content, 'utf8') : 0),
      0,
    );
    if (total > IMPORT_MAX_TOTAL_BYTES) {
      throw new Error(`total content must be <= ${IMPORT_MAX_TOTAL_BYTES} bytes`);
    }
    return true;
  }),
];

router.post(
  '/projects/:id/files',
  authenticateToken,
  requireCodexAgentAccess,
  importFilesValidators,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });

    let project;
    try {
      project = await loadOwnedProject(req, res);
      if (!project) return undefined;
      if (await runService.hasActiveRun({ projectId: project.id })) {
        return res.status(409).json({
          error: 'run_in_progress',
          message: 'Hay un run activo en este proyecto; espera a que termine antes de importar archivos.',
        });
      }
    } catch (err) {
      return res.status(500).json({ error: 'codex_import_failed', message: err.message });
    }

    try {
      const files = req.body.files.map((f) => ({ path: String(f.path), content: String(f.content) }));
      await createRunnerClient().writeFiles(project.id, files);
      return res.json({ ok: true, written: files.length });
    } catch (err) {
      return res.status(502).json({ error: 'runner_unreachable', message: err.message });
    }
  },
);

router.get('/projects/:id/file', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const path = String(req.query.path || '').trim();
    if (!path) return res.status(400).json({ error: 'path_required' });
    const out = await createRunnerClient().readFile(project.id, path);
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

// ── Runs (feature 05) ───────────────────────────────────────────────────────
// Create/list/detail are scoped under the project (POST/GET /projects/:id/runs)
// so they never shadow the legacy codex-runs router, which is mounted first and
// owns POST /runs + GET /runs/:id. Cancel + stream live at /runs/:id/* (paths
// the legacy router does not define), so they fall through to here.
function mapRunError(err, res) {
  if (err instanceof runService.RunServiceError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  return res.status(500).json({ error: 'codex_run_failed', message: err.message });
}

router.post(
  '/projects/:projectId/runs',
  authenticateToken,
  requireCodexAgentAccess,
  [
    body('mode').isString().bail().isIn(['plan', 'build']).withMessage('mode must be plan or build'),
    body('prompt').optional({ nullable: true }).isString().isLength({ max: 20000 }),
    body('model').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('tier').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('planRunId').optional({ nullable: true }).isString().isLength({ max: 64 }),
    // Re-planning (G4): re-work an earlier plan given the user's feedback.
    body('priorPlanRunId').optional({ nullable: true }).isString().isLength({ max: 64 }),
    body('feedback').optional({ nullable: true }).isString().isLength({ max: 4000 })
      .withMessage('feedback must be a string of at most 4000 chars'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const run = await runService.createRun({
        userId: req.user.id,
        projectId: req.params.projectId,
        mode: req.body.mode,
        prompt: req.body.prompt ?? null,
        model: req.body.model ?? null,
        tier: req.body.tier ?? null,
        planRunId: req.body.planRunId ?? null,
        priorPlanRunId: req.body.priorPlanRunId ?? null,
        feedback: req.body.feedback ?? null,
      });
      return res.status(201).json({ run });
    } catch (err) {
      return mapRunError(err, res);
    }
  },
);

router.get('/projects/:projectId/runs', authenticateToken, async (req, res) => {
  try {
    const runs = await runService.listRuns({ userId: req.user.id, projectId: req.params.projectId });
    return res.json({ runs });
  } catch (err) {
    return mapRunError(err, res);
  }
});

router.get('/projects/:projectId/runs/:runId', authenticateToken, async (req, res) => {
  try {
    const run = await runService.getRun({ userId: req.user.id, runId: req.params.runId });
    if (!run || run.projectId !== req.params.projectId) return res.status(404).json({ error: 'run_not_found' });
    return res.json({ run });
  } catch (err) {
    return mapRunError(err, res);
  }
});

router.post('/runs/:id/cancel', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const run = await runService.cancelRun({ userId: req.user.id, runId: req.params.id });
    return res.json({ run });
  } catch (err) {
    return mapRunError(err, res);
  }
});

// ── Checkpoints (feature 07) ────────────────────────────────────────────────
// /checkpoints/* and /projects/:id/checkpoints do not collide with the legacy
// codex-runs router. Ownership is enforced inside checkpoint-service via the
// project relation; the service returns { error, status } which we map here.
router.post('/checkpoints/:id/rollback', authenticateToken, async (req, res) => {
  try {
    const out = await checkpointService.rollbackCheckpoint({
      checkpointId: req.params.id,
      userId: req.user.id,
      deps: { runner: createRunnerClient() },
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error, detail: out.detail });
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/checkpoints/:id/diff', authenticateToken, async (req, res) => {
  try {
    const out = await checkpointService.getCheckpointDiff({
      checkpointId: req.params.id,
      userId: req.user.id,
      deps: { runner: createRunnerClient() },
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:projectId/checkpoints', authenticateToken, async (req, res) => {
  try {
    const checkpoints = await checkpointService.listCheckpoints({ userId: req.user.id, projectId: req.params.projectId });
    if (checkpoints === null) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ checkpoints });
  } catch (err) {
    return res.status(500).json({ error: 'codex_checkpoints_failed', message: err.message });
  }
});

// ── GET /api/codex/runs/:id/stream — SSE replay + live (feature 04) ─────────
// Replays codex_events with seq > afterSeq from the DB (the durable source of
// truth) and then attaches the live Redis channel. Subscribe-before-replay +
// a per-stream seq gate guarantee no loss and no duplicates across reconnects.
router.get('/runs/:id/stream', bearerFromQueryFallback, authenticateToken, async (req, res) => {
  const runId = String(req.params.id);
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  let run;
  try {
    run = await runAccess.findOwnedRun({ runId, userId });
  } catch (err) {
    return res.status(503).json({ error: 'persistence_unavailable', message: err.message });
  }
  if (!run) return res.status(404).json({ error: 'run_not_found' });

  const afterSeq = Number.parseInt(req.query.afterSeq, 10);
  const startSeq = Number.isFinite(afterSeq) ? afterSeq : 0;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const gate = eventStore.createSeqGate();
  let closed = false;
  let subscriber = null;
  let heartbeat = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (subscriber) Promise.resolve(subscriber.close()).catch(() => {});
  }
  req.on('close', cleanup);
  res.on('close', cleanup);

  function write(envelope) {
    if (closed || res.writableEnded) return false;
    try {
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  // Emit through the gate; close the stream once a terminal run_status passes.
  function emit(envelope) {
    if (closed) return;
    if (!gate.shouldEmit(envelope.seq)) return;
    write(envelope);
    if (envelope.type === 'run_status' && runAccess.isTerminalStatus(envelope.data?.status)) {
      cleanup();
      if (!res.writableEnded) res.end();
    }
  }

  // Buffer live events that arrive while we replay, then flush them (the gate
  // dedups against the replay) and continue streaming live.
  const liveBuffer = [];
  let replaying = true;
  try {
    subscriber = await pubsub.createRunSubscriber(runId, (envelope) => {
      if (replaying) liveBuffer.push(envelope);
      else emit(envelope);
    });
  } catch {
    subscriber = null; // Redis down → replay-only; client reconnects for more.
  }

  try {
    const history = await eventStore.listEvents(runId, { afterSeq: startSeq });
    for (const ev of history) {
      emit(ev);
      if (closed) break;
    }
  } catch (err) {
    write({ type: 'error', message: err.message || 'replay_failed' });
    cleanup();
    if (!res.writableEnded) res.end();
    return undefined;
  }

  replaying = false;
  for (const ev of liveBuffer.splice(0)) {
    emit(ev);
    if (closed) break;
  }

  // Already-terminal run: the worker has finished and will publish nothing more,
  // so replay (+ any buffered live tail) was the whole story. Close the stream
  // now instead of holding it open — even with a live subscriber attached, since
  // no further events will ever arrive (e.g. a client reconnecting with an
  // afterSeq past the terminal run_status would otherwise hang forever).
  if (!closed && runAccess.isTerminalStatus(run.status)) {
    cleanup();
    if (!res.writableEnded) res.end();
    return undefined;
  }

  if (!closed) {
    heartbeat = setInterval(() => {
      write({ type: 'heartbeat', ts: new Date().toISOString() });
    }, 25_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }
  return undefined;
});

module.exports = router;
