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
 *   GET  /api/codex/projects/:id/budget          → gasto/corte diario  (auth)
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
const { body, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const requirePaidPlan = require('../middleware/require-paid-plan');
const { isCodexV2Enabled } = require('../services/codex/flags');
const { canUseCodexAgent, publicAccess } = require('../services/codex/access-control');
const projectService = require('../services/codex/project-service');
const { createSandboxClient } = require('../services/codex/sandbox-provider');
const { runnerDevUrl, codexExportHostPath } = require('../services/codex/runner-client');
const eventStore = require('../services/codex/event-store');
const runAccess = require('../services/codex/run-access');
const pubsub = require('../services/codex/redis-pubsub');
const runService = require('../services/codex/run-service');
const checkpointService = require('../services/codex/checkpoint-service');
const {
  CodexSessionError,
  createSessionService,
} = require('../services/codex/session-service');
const codexDb = require('../config/database');
const publicationService = require('../services/codex/publication-service');
const companyAssociationService = require('../services/codex/company-association-service');
const {
  STRIP_REQUEST_HEADERS,
  HOP_BY_HOP_HEADERS,
} = require('../utils/proxy-headers');
const {
  attachWebSocketProxy,
} = require('../services/codex/preview-websocket-proxy');
const {
  applyPreviewFrameHeaders: applyPreviewFramePolicy,
  filterPreviewResponseHeaders,
  injectPreviewConsoleBridge,
  previewTokenFor: mintPreviewToken,
  previewNonceFromRequest,
  previewOriginAllowed,
  readPreviewBody,
  stripPreviewNonce,
  verifyPreviewToken: verifySignedPreviewToken,
} = require('../services/code/preview-proxy');

const router = express.Router();
let sessionRunner = null;
let sessionService = null;

function sendCompanyAssociationError(res, error) {
  if (error instanceof companyAssociationService.CompanyAssociationError) {
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'company_association_failed',
    message: 'Company association request failed.',
  });
}

function codexSessionRuntime() {
  sessionRunner = sessionRunner || createSandboxClient();
  sessionService = sessionService || createSessionService({ db: codexDb });
  return { runner: sessionRunner, service: sessionService };
}

function mapSessionError(error, res) {
  if (error instanceof CodexSessionError) {
    return res.status(400).json({ error: error.code, message: error.message, details: error.details || undefined });
  }
  return res.status(502).json({ error: 'codex_session_failed', message: String(error?.message || error) });
}

function verifyPreviewToken(token, env = process.env) {
  return verifySignedPreviewToken(token, env);
}

function previewTokenFor({ projectId, userId }, env = process.env) {
  return mintPreviewToken({ projectId, userId }, env);
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
    const st = await createSandboxClient().devStatus(projectId);
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

function previewUpgradeParts(request) {
  try {
    const url = new URL(String(request?.url || ''), 'http://preview.local');
    const match = /^\/api\/codex\/projects\/([^/]+)\/preview\/([^/]+)\/app(?:\/.*)?$/.exec(url.pathname);
    if (!match) return null;
    return {
      projectId: decodeURIComponent(match[1]),
      token: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function previewUpgradeError(statusCode) {
  const error = new Error('preview_websocket_rejected');
  error.statusCode = statusCode;
  return error;
}

async function previewWebSocketTarget(request, env = process.env) {
  const parts = previewUpgradeParts(request);
  if (!parts) throw previewUpgradeError(404);
  const payload = verifyPreviewToken(parts.token, env);
  if (!payload || payload.projectId !== parts.projectId) throw previewUpgradeError(403);

  const projectPort = await resolvePreviewPort(parts.projectId, env);
  let upstreamBase;
  try {
    upstreamBase = new URL(codexPreviewInternalUrl(env, projectPort));
  } catch {
    throw previewUpgradeError(503);
  }
  if (!['http:', 'https:'].includes(upstreamBase.protocol)) throw previewUpgradeError(503);

  const target = new URL(stripPreviewNonce(String(request.url || '/')), upstreamBase);
  target.protocol = upstreamBase.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    url: target.toString(),
    host: previewProxyHostHeader(upstreamBase, env),
  };
}

function attachPreviewWebSocketProxy(server, env = process.env) {
  return attachWebSocketProxy(server, {
    shouldHandle: (request) => Boolean(previewUpgradeParts(request)),
    isOriginAllowed: (request) => previewOriginAllowed(request.headers?.origin, env),
    resolveTarget: (request) => previewWebSocketTarget(request, env),
  });
}

function requireCodexAgentAccess(req, res, next) {
  if (canUseCodexAgent(req.user, process.env)) return next();
  return res.status(403).json({ error: 'codex_forbidden', message: 'Tu cuenta no puede ejecutar APPS en producción.' });
}

function applyPreviewFrameHeaders(_req, res, next) {
  applyPreviewFramePolicy(res);
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
  // previewOrigin: sibling origin that serves the tokenized preview proxy
  // (Caddy vhost). When set, the frontend iframes codex previews from there
  // WITHOUT a sandbox — browser origin isolation replaces it (Replit model).
  // Null ⇒ same-origin preview with the sandboxed iframe.
  const previewOrigin = String(process.env.CODEX_PREVIEW_ORIGIN || '').trim().replace(/\/+$/, '') || null;
  const body = JSON.stringify({ ok: true, enabled: isCodexV2Enabled(), previewOrigin });
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

// Existing localStorage mappings are never trusted or backfilled. The
// association wizard reads these endpoints and the owner confirms each link.
router.get(
  '/company-associations',
  authenticateToken,
  [query('projectId').isString().trim().isLength({ min: 1, max: 160 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const state = await companyAssociationService.associationForCompany(codexDb, {
        userId: req.user.id,
        projectId: req.query.projectId,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(state);
    } catch (error) {
      return sendCompanyAssociationError(res, error);
    }
  },
);

router.get('/company-associations/orphans', authenticateToken, async (req, res) => {
  try {
    const orphans = await companyAssociationService.listOrphans(codexDb, {
      userId: req.user.id,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(orphans);
  } catch (error) {
    return sendCompanyAssociationError(res, error);
  }
});

router.post(
  '/company-associations',
  authenticateToken,
  [
    body('projectId').isString().trim().isLength({ min: 1, max: 160 }),
    body('codexProjectId').isString().trim().isLength({ min: 1, max: 160 }),
    body('connectorAccountIds').optional().isArray({ max: 100 }),
    body('connectorAccountIds.*').optional().isString().trim().isLength({ min: 1, max: 160 }),
    body('source').optional().isIn(['manual', 'created_for_company']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      const result = await companyAssociationService.associateCompany(codexDb, {
        userId: req.user.id,
        projectId: req.body.projectId,
        codexProjectId: req.body.codexProjectId,
        connectorAccountIds: req.body.connectorAccountIds,
        source: req.body.source,
      });
      return res.status(201).json(result);
    } catch (error) {
      return sendCompanyAssociationError(res, error);
    }
  },
);

router.put(
  '/company-associations/:projectId/connectors',
  authenticateToken,
  [
    body('connectorAccountIds').isArray({ max: 100 }),
    body('connectorAccountIds.*').optional().isString().trim().isLength({ min: 1, max: 160 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    try {
      return res.json(await companyAssociationService.assignCompanyConnectors(codexDb, {
        userId: req.user.id,
        projectId: req.params.projectId,
        connectorAccountIds: req.body.connectorAccountIds,
      }));
    } catch (error) {
      return sendCompanyAssociationError(res, error);
    }
  },
);

router.post(
  '/company-associations/:projectId/connectors/:connectorAccountId',
  authenticateToken,
  async (req, res) => {
    try {
      return res.json(await companyAssociationService.addCompanyConnector(codexDb, {
        userId: req.user.id,
        projectId: req.params.projectId,
        connectorAccountId: req.params.connectorAccountId,
      }));
    } catch (error) {
      return sendCompanyAssociationError(res, error);
    }
  },
);

router.delete(
  '/company-associations/:projectId/connectors/:connectorAccountId',
  authenticateToken,
  async (req, res) => {
    try {
      return res.json(await companyAssociationService.removeCompanyConnector(codexDb, {
        userId: req.user.id,
        projectId: req.params.projectId,
        connectorAccountId: req.params.connectorAccountId,
      }));
    } catch (error) {
      return sendCompanyAssociationError(res, error);
    }
  },
);

router.post(
  '/projects',
  authenticateToken,
  requireCodexAgentAccess,
  [
    body('name').isString().withMessage('name must be a string').bail().trim().isLength({ min: 1, max: 80 }),
    body('organizationId').optional({ nullable: true }).isString().trim().isLength({ min: 1, max: 160 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const organizationId = req.body.organizationId || null;
      if (organizationId && !(await companyAssociationService.hasOrganizationAccess(codexDb, {
        userId: req.user.id,
        organizationId,
      }))) {
        return res.status(404).json({ error: 'organization_not_found' });
      }
      const project = await projectService.createProject({
        userId: req.user.id,
        organizationId,
        name: req.body.name.trim(),
        brief: req.body.brief ?? null,
        repository: req.body.repository ?? null,
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

router.get('/projects/:id/budget', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const runner = createSandboxClient();
    const settingsState = await require('../services/codex/project-settings')
      .loadProjectSettings({ runner, projectId: project.id, project });
    if (settingsState.error) {
      return res.status(422).json({
        error: 'invalid_project_settings',
        message: settingsState.error,
      });
    }
    const budget = await require('../services/codex/project-budget').checkProjectBudget({
      prisma: codexDb,
      projectId: project.id,
      settings: settingsState.settings,
      env: process.env,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ budget });
  } catch (err) {
    return res.status(500).json({ error: 'codex_budget_failed', message: err.message });
  }
});

// ── Modo PROACTIVO (compañía de agentes autónoma, estilo matrix.build) ──────
// GET  /projects/:id/proactive  → estado + departamentos
// POST /projects/:id/proactive  { enabled } → toggle; al ENCENDER dispara un
// primer ciclo inmediato (fire-and-forget) para que el usuario vea acción ya.
router.get('/projects/:id/proactive', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const proactive = require('../services/codex/proactive-engine');
    const companyDepartments = require('../services/codex/company-departments');
    const memory = require('../services/codex/progress-ledger').readProgressContext(project);
    const company = await require('../services/codex/company-operating-profile')
      .loadCompanyOperatingContext({ prisma: codexDb, project });
    const departments = companyDepartments.readDepartments(project);
    const pools = await require('../services/codex/department-pools')
      .listDepartmentPools({ prisma: codexDb, projectId: project.id });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      state: proactive.readProactiveState(project),
      departments,
      departmentPools: pools,
      capacity: companyDepartments.capacitySummary(departments, pools),
      memory,
      company,
    });
  } catch (err) {
    return res.status(500).json({ error: 'codex_proactive_failed', message: err.message });
  }
});

router.post('/projects/:id/proactive', authenticateToken, async (req, res) => {
  try {
    const enabled = req.body && req.body.enabled === true;
    // Enabling starts autonomous code execution immediately. Keep the same
    // isolation/access gate as manual runs; disabling remains available to
    // the project owner so a previously enabled loop can always be stopped.
    if (enabled && !canUseCodexAgent(req.user, process.env)) {
      return res.status(403).json({
        error: 'codex_forbidden',
        message: 'Tu cuenta no puede ejecutar APPS en producción.',
      });
    }
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const proactive = require('../services/codex/proactive-engine');
    const companyDepartments = require('../services/codex/company-departments');
    const prisma = require('../config/database');
    const out = await proactive.setProactive({ prisma, projectId: project.id, userId: req.user.id, enabled });
    if (!out) return res.status(404).json({ error: 'project_not_found' });
    if (enabled) {
      // Primer ciclo inmediato — best-effort, nunca bloquea la respuesta.
      prisma.codexProject.findFirst({ where: { id: project.id, userId: req.user.id } })
        .then((fresh) => (fresh ? proactive.runCycle({ project: fresh, deps: { prisma } }) : null))
        .catch((err) => console.warn('[codex proactive] first cycle failed:', err?.message || err));
    }
    const fresh = await prisma.codexProject.findFirst({ where: { id: project.id, userId: req.user.id } });
    const departments = companyDepartments.readDepartments(fresh || project);
    const pools = await require('../services/codex/department-pools')
      .listDepartmentPools({ prisma, projectId: project.id });
    return res.json({
      state: out.state,
      departments,
      departmentPools: pools,
      capacity: companyDepartments.capacitySummary(departments, pools),
    });
  } catch (err) {
    return res.status(500).json({ error: 'codex_proactive_failed', message: err.message });
  }
});

function sendOkrError(res, error) {
  const progressLedger = require('../services/codex/progress-ledger');
  if (error instanceof progressLedger.ObjectivePortfolioError) {
    return res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  return res.status(500).json({
    error: 'codex_okrs_failed',
    message: String(error?.message || error || 'OKR operation failed.').slice(0, 2_000),
  });
}

// ── Cartera OKR revisada por CEO Office ────────────────────────────────────
// Objectives remain in the existing tenant-owned CodexProject brief. Every
// review/reprioritization increments a revision and appends bounded audit
// metadata; none of these routes can trigger a run or an external action.
router.get('/projects/:id/okrs', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const portfolio = require('../services/codex/progress-ledger')
      .readObjectivePortfolio(project);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ portfolio });
  } catch (error) {
    return sendOkrError(res, error);
  }
});

router.put('/projects/:id/okrs/review', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    if (!Array.isArray(req.body?.objectives) || !req.body.objectives.length) {
      return res.status(400).json({
        error: 'okr_objectives_required',
        message: 'objectives must contain at least one business objective.',
      });
    }
    const expectedRevision = Number.parseInt(req.body?.expectedRevision, 10);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({
        error: 'okr_revision_required',
        message: 'expectedRevision must be a non-negative integer.',
      });
    }
    const reviewerIdentity = String(
      req.user?.name || req.user?.email || req.user?.id || 'Owner',
    ).slice(0, 100);
    const portfolio = await require('../services/codex/progress-ledger').reviewObjectives({
      prisma: codexDb,
      project,
      objectives: req.body.objectives,
      reviewer: `CEO Office · ${reviewerIdentity}`,
      source: 'ceo_review',
      decision: req.body?.decision,
      rationale: typeof req.body?.rationale === 'string'
        ? req.body.rationale.slice(0, 1_200)
        : null,
      expectedRevision,
    });
    return res.json({ portfolio });
  } catch (error) {
    return sendOkrError(res, error);
  }
});

router.post('/projects/:id/okrs/reprioritize', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const expectedRevision = Number.parseInt(req.body?.expectedRevision, 10);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return res.status(400).json({
        error: 'okr_revision_required',
        message: 'expectedRevision must be a non-negative integer.',
      });
    }
    const reviewerIdentity = String(
      req.user?.name || req.user?.email || req.user?.id || 'Owner',
    ).slice(0, 100);
    const portfolio = await require('../services/codex/progress-ledger')
      .reprioritizeObjectives({
        prisma: codexDb,
        project,
        orderedIds: req.body?.orderedIds,
        reviewer: `CEO Office · ${reviewerIdentity}`,
        rationale: typeof req.body?.rationale === 'string'
          ? req.body.rationale.slice(0, 1_200)
          : null,
        expectedRevision,
      });
    return res.json({ portfolio });
  } catch (error) {
    return sendOkrError(res, error);
  }
});

router.put('/projects/:id/departments', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const department = req.body?.department ?? req.body;
    if (!department || typeof department !== 'object' || Array.isArray(department)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'department must be an object',
      });
    }
    const service = require('../services/codex/company-departments');
    const departments = await service.upsertDepartment({
      prisma: codexDb,
      project,
      department,
    });
    const pools = await require('../services/codex/department-pools')
      .listDepartmentPools({ prisma: codexDb, projectId: project.id });
    return res.json({
      departments,
      departmentPools: pools,
      capacity: service.capacitySummary(departments, pools),
    });
  } catch (err) {
    const status = err?.message === 'department_name_required' ? 400 : 500;
    return res.status(status).json({
      error: status === 400 ? 'validation_failed' : 'codex_departments_failed',
      message: err.message,
    });
  }
});

router.delete('/projects/:id/departments/:departmentId', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const service = require('../services/codex/company-departments');
    const departments = await service.deleteDepartment({
      prisma: codexDb,
      project,
      departmentId: req.params.departmentId,
    });
    const pools = await require('../services/codex/department-pools')
      .listDepartmentPools({ prisma: codexDb, projectId: project.id });
    return res.json({
      departments,
      departmentPools: pools,
      capacity: service.capacitySummary(departments, pools),
    });
  } catch (err) {
    const known = {
      department_not_found: 404,
      cannot_delete_ceo_office: 400,
    };
    const status = known[err?.message] || 500;
    return res.status(status).json({
      error: status === 500 ? 'codex_departments_failed' : err.message,
      message: err.message,
    });
  }
});

router.get('/projects/:id/department-pools', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const departmentsService = require('../services/codex/company-departments');
    const poolsService = require('../services/codex/department-pools');
    const departments = departmentsService.readDepartments(project);
    const pools = await poolsService.listDepartmentPools({ prisma: codexDb, projectId: project.id });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      departmentPools: pools,
      capacity: departmentsService.capacitySummary(departments, pools),
    });
  } catch (err) {
    return res.status(500).json({ error: 'codex_department_pools_failed', message: err.message });
  }
});

router.put('/projects/:id/department-pools/:departmentId', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const departmentsService = require('../services/codex/company-departments');
    const poolsService = require('../services/codex/department-pools');
    const departments = departmentsService.readDepartments(project);
    const department = departments.find((row) => row.id === req.params.departmentId);
    if (!department) {
      return res.status(404).json({ error: 'department_not_found', message: 'department_not_found' });
    }
    await poolsService.upsertDepartmentPool({
      prisma: codexDb,
      project,
      departmentId: department.id,
      size: req.body?.size ?? department.desiredAgents,
      dailyBudgetUsd: Object.prototype.hasOwnProperty.call(req.body || {}, 'dailyBudgetUsd')
        ? req.body.dailyBudgetUsd
        : undefined,
      enabled: req.body?.enabled !== false,
    });
    const pools = await poolsService.listDepartmentPools({ prisma: codexDb, projectId: project.id });
    return res.json({
      departmentPools: pools,
      capacity: departmentsService.capacitySummary(departments, pools),
    });
  } catch (err) {
    const status = ['invalid_department_pool_budget', 'department_pool_invalid'].includes(err?.message)
      ? 400
      : 500;
    return res.status(status).json({
      error: status === 400 ? 'validation_failed' : 'codex_department_pools_failed',
      message: err.message,
    });
  }
});

// ── Recursos asignados por empresa/departamento ────────────────────────────
// Stored in CodexProject.brief so the same authenticated user sees the same
// assignments on every browser without leaking them across companies.
router.get('/projects/:id/company-resources', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const service = require('../services/codex/company-resources');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ resources: service.readCompanyResources(project) });
  } catch (err) {
    return res.status(500).json({
      error: 'codex_company_resources_failed',
      message: err.message,
    });
  }
});

router.put('/projects/:id/company-resources', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const service = require('../services/codex/company-resources');
    const resources = await service.writeCompanyResources({
      prisma: codexDb,
      project,
      resources: req.body,
      expectedRevision: req.body?.expectedRevision,
    });
    return res.json({ resources });
  } catch (err) {
    const service = require('../services/codex/company-resources');
    if (err instanceof service.CompanyResourcesError) {
      return res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    return res.status(500).json({
      error: 'codex_company_resources_failed',
      message: err.message,
    });
  }
});

// ── Perfil operativo de empresa ─────────────────────────────────────────────
// Intent belongs to the user/company; connection readiness is always derived
// from real runtime evidence (workspace, publication, OAuth and Gmail).
router.get('/projects/:id/company-profile', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const companyProfile = require('../services/codex/company-operating-profile');
    const company = await companyProfile.loadCompanyOperatingContext({ prisma: codexDb, project });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ company });
  } catch (err) {
    return res.status(500).json({ error: 'codex_company_profile_failed', message: err.message });
  }
});

router.patch('/projects/:id/company-profile', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const patch = req.body?.profile ?? req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({
        error: 'validation_failed',
        message: 'profile must be an object',
      });
    }
    const requestsAuto = patch.autonomy
      && typeof patch.autonomy === 'object'
      && Object.values(patch.autonomy).some((value) => value === 'auto');
    if (requestsAuto && req.body?.confirmAuto !== true) {
      return res.status(409).json({
        error: 'company_auto_confirmation_required',
        message: 'Explicit confirmation is required before enabling automatic external actions.',
      });
    }
    const companyProfile = require('../services/codex/company-operating-profile');
    await companyProfile.writeCompanyProfile({
      prisma: codexDb,
      project,
      patch,
    });
    const fresh = await codexDb.codexProject.findFirst({
      where: { id: project.id, userId: req.user.id },
    });
    await require('../services/codex/company-registry')
      .ensureCompanyForCodexProject({ prisma: codexDb, codexProject: fresh || project })
      .catch(() => null);
    const company = await companyProfile.loadCompanyOperatingContext({
      prisma: codexDb,
      project: fresh || project,
    });
    return res.json({ company });
  } catch (err) {
    return res.status(500).json({ error: 'codex_company_profile_failed', message: err.message });
  }
});

router.post(
  '/projects/:id/business-audit',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyProfile = require('../services/codex/company-operating-profile');
      const analyzer = require('../services/codex/business-analyzer');
      const companyContext = await companyProfile.loadCompanyOperatingContext({
        prisma: codexDb,
        project,
      });
      const audit = await analyzer.analyzeBusiness({
        project,
        companyContext,
        networkEnabled: true,
      });
      await analyzer.persistBusinessAudit({ prisma: codexDb, project, audit });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        audit,
        company: { ...companyContext, businessAudit: audit },
      });
    } catch (err) {
      return res.status(Number(err?.status) || 500).json({
        error: err?.code || 'codex_business_audit_failed',
        message: String(err?.message || err || 'Business audit failed.').slice(0, 2_000),
      });
    }
  },
);

async function loadOwnedCompany(project) {
  return require('../services/codex/company-registry')
    .ensureCompanyForCodexProject({ prisma: codexDb, codexProject: project });
}

router.get('/projects/:id/business-channels', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const company = await loadOwnedCompany(project);
    if (!company) {
      return res.status(409).json({
        error: 'company_association_required',
        message: 'Asocia primero esta Empresa con su entorno APPS.',
      });
    }
    const service = require('../services/codex/business-channels');
    const channels = await service.listBusinessChannels({
      prisma: codexDb,
      companyId: company.id,
      userId: req.user.id,
    });
    const inbox = codexDb.inboxMessage?.findMany
      ? await codexDb.inboxMessage.findMany({
        where: { companyId: company.id },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      })
      : [];
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ company, channels, inbox });
  } catch (err) {
    return res.status(500).json({ error: 'codex_business_channels_failed', message: err.message });
  }
});

async function upsertBusinessChannelRoute(req, res) {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const company = await loadOwnedCompany(project);
    if (!company) return res.status(409).json({ error: 'company_association_required' });
    const service = require('../services/codex/business-channels');
    const channel = await service.upsertBusinessChannel({
      prisma: codexDb,
      company,
      channelId: req.params.channelId || null,
      input: req.body?.channel ?? req.body,
      env: process.env,
    });
    return res.json({ channel });
  } catch (err) {
    const known = {
      invalid_channel_kind: 400,
      connector_not_available: 409,
      business_channel_not_found: 404,
      channel_credentials_key_unavailable: 503,
    };
    const status = Number(err?.status) || known[err?.message] || 500;
    return res.status(status).json({
      error: status === 500 ? 'codex_business_channels_failed' : err.message,
      message: err.message,
    });
  }
}

router.put('/projects/:id/business-channels', authenticateToken, upsertBusinessChannelRoute);
router.put('/projects/:id/business-channels/:channelId', authenticateToken, upsertBusinessChannelRoute);

router.post('/projects/:id/business-channels/:channelId/pair', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const company = await loadOwnedCompany(project);
    if (!company) return res.status(409).json({ error: 'company_association_required' });
    const channel = await require('../services/codex/business-channels').approvePairing({
      prisma: codexDb,
      company,
      channelId: req.params.channelId,
      senderRef: req.body?.from,
      code: req.body?.code,
      env: process.env,
    });
    return res.json({ channel });
  } catch (err) {
    const status = err?.message === 'business_channel_not_found'
      ? 404
      : err?.message === 'sender_statically_allowlisted'
        ? 409
        : ['invalid_or_expired_pairing_code', 'invalid_pairing_sender'].includes(err?.message)
          ? 400
          : 500;
    return res.status(status).json({
      error: status === 500 ? 'codex_channel_pairing_failed' : err.message,
      message: err.message,
    });
  }
});

router.delete('/projects/:id/business-channels/:channelId/pair', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const company = await loadOwnedCompany(project);
    if (!company) return res.status(409).json({ error: 'company_association_required' });
    const channel = await require('../services/codex/business-channels').revokePairing({
      prisma: codexDb,
      company,
      channelId: req.params.channelId,
      senderRef: req.body?.from,
    });
    return res.json({ channel });
  } catch (err) {
    const status = err?.message === 'business_channel_not_found'
      ? 404
      : err?.message === 'sender_statically_allowlisted'
        ? 409
        : err?.message === 'invalid_pairing_sender'
          ? 400
          : 500;
    return res.status(status).json({
      error: status === 500 ? 'codex_channel_pairing_revoke_failed' : err.message,
      message: err.message,
    });
  }
});

router.post(
  '/projects/:id/business-channels/:channelId/inbox',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const company = await loadOwnedCompany(project);
      if (!company) return res.status(409).json({ error: 'company_association_required' });
      const result = await require('../services/codex/business-channels').recordInboundMessage({
        prisma: codexDb,
        company,
        channelId: req.params.channelId,
        message: req.body?.message ?? req.body,
        runService: require('../services/codex/run-service'),
        env: process.env,
      });
      return res.status(result.authorization.allowed ? 202 : 428).json(result);
    } catch (err) {
      const status = ['invalid_inbox_message'].includes(err?.message)
        ? 400
        : err?.message === 'business_channel_not_found'
          ? 404
          : 500;
      return res.status(status).json({
        error: status === 500 ? 'codex_channel_inbox_failed' : err.message,
        message: err.message,
      });
    }
  },
);

router.get('/projects/:id/business-channels-doctor', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const company = await loadOwnedCompany(project);
    if (!company) return res.status(409).json({ error: 'company_association_required' });
    const audit = await require('../services/codex/business-channels').auditChannelPolicies({
      prisma: codexDb,
      companyId: company.id,
      userId: req.user.id,
    });
    return res.json({ audit });
  } catch (err) {
    return res.status(500).json({ error: 'codex_channel_doctor_failed', message: err.message });
  }
});

function sendCompanyOperationsError(res, err) {
  return res.status(Number(err?.status) || 500).json({
    error: err?.code || 'codex_company_operations_failed',
    message: String(err?.message || err || 'Company operations failed').slice(0, 2000),
  });
}

router.get('/projects/:id/company-operations', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const snapshot = await require('../services/codex/company-operations').getOperationsSnapshot({
      prisma: codexDb,
      project,
      take: req.query?.take,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ operations: snapshot });
  } catch (err) {
    return sendCompanyOperationsError(res, err);
  }
});

// ── Estado de oficina: la fuente de verdad que la oficina visual lee ───────
// One read-only projection with the seven signals the office renders: active
// pools (capacity/budget/spend today), missions, runs, cost, evidence,
// pending approvals and blockers. Same safe-projection rule as /activity:
// no prompts, drafts, snapshots or credentials ever leave this endpoint.
router.get('/projects/:id/office-state', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const state = await require('../services/codex/office-state').getOfficeState({
      prisma: codexDb,
      project,
      take: req.query?.take,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ state });
  } catch (err) {
    return res.status(Number(err?.status) || 500).json({
      error: err?.code || 'codex_office_state_failed',
      message: String(err?.message || err || 'Office state failed').slice(0, 2_000),
    });
  }
});

// ── Actividad agregada de todos los departamentos ──────────────────────────
// The per-run SSE stream remains the source of truth for a live coding turn.
// This safe projection lets CEO Office render one project-wide timeline
// without exposing prompts, snapshots, credentials or raw command output.
router.get('/projects/:id/activity', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const activity = await require('../services/codex/project-activity').listProjectActivity({
      prisma: codexDb,
      projectId: project.id,
      limit: req.query.limit,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ activity });
  } catch (err) {
    return res.status(500).json({ error: 'codex_activity_failed', message: err.message });
  }
});

function sendMissionEvidenceError(res, err) {
  return res.status(Number(err?.status) || 500).json({
    error: err?.code || 'codex_mission_evidence_failed',
    message: String(err?.message || err || 'Mission evidence failed').slice(0, 2_000),
  });
}

// ── Entregables y evidencia de misión ──────────────────────────────────────
// Durable, tenant-scoped records live in additive mission, artifact, report
// and CEO approval tables. Legacy brief entries are imported on read. Email
// delivery is intentionally absent: reports can only become drafts or queued
// work after connection + permission.
router.get('/projects/:id/mission-evidence', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const ledger = await require('../services/codex/mission-evidence-ledger')
      .syncMissionEvidence({ prisma: codexDb, project });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ledger });
  } catch (err) {
    return sendMissionEvidenceError(res, err);
  }
});

router.patch('/projects/:id/mission-evidence/:recordId/review', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const record = await require('../services/codex/mission-evidence-ledger')
      .reviewMissionRecord({
        prisma: codexDb,
        project,
        recordId: String(req.params.recordId || '').slice(0, 220),
        status: req.body?.status,
        note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 1_000) : null,
        reviewer: String(req.user?.name || req.user?.email || 'CEO Office').slice(0, 120),
      });
    return res.json({ record });
  } catch (err) {
    return sendMissionEvidenceError(res, err);
  }
});

router.post(
  '/projects/:id/activity-reports',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyContext = await require('../services/codex/company-operating-profile')
        .loadCompanyOperatingContext({ prisma: codexDb, project });
      const report = await require('../services/codex/mission-evidence-ledger')
        .createActivityReport({
          prisma: codexDb,
          project,
          companyContext,
          days: req.body?.days,
          requestEmail: req.body?.requestEmail === true,
          confirmEmailQueue: req.body?.confirmEmailQueue === true,
        });
      return res.status(201).json({ report });
    } catch (err) {
      return sendMissionEvidenceError(res, err);
    }
  },
);

function sendSwarmError(res, error) {
  const status = Number(error?.status) || (
    error?.code === 'P2002' ? 409 : 500
  );
  return res.status(status).json({
    error: error?.code === 'P2002'
      ? 'codex_swarm_in_progress'
      : (error?.code || 'codex_swarm_failed'),
    message: String(error?.message || 'Enterprise swarm failed.').slice(0, 2_000),
    ...(error?.details ? { details: error.details } : {}),
  });
}

function boundedSwarmInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

/** Effective swarm research concurrency. Writers stay capped by run isolation. */
function swarmConcurrencyDefaults(env = process.env) {
  const hardMax = boundedSwarmInteger(env.SIRAGPT_SWARM_MAX_CONCURRENCY_HARD, 256, 32, 256);
  const defaultConcurrency = boundedSwarmInteger(
    env.SIRAGPT_SWARM_MAX_CONCURRENCY_DEFAULT,
    128,
    1,
    hardMax,
  );
  const defaultWriters = boundedSwarmInteger(
    env.SIRAGPT_SWARM_MAX_WRITERS_DEFAULT,
    4,
    1,
    Math.min(32, hardMax),
  );
  // Logical agent capacity (10k) — research shards + writers + QA, not 10k concurrent LLMs.
  const hardLogical = boundedSwarmInteger(env.SIRAGPT_SWARM_MAX_LOGICAL_HARD, 10_000, 1_000, 10_000);
  const defaultLogical = boundedSwarmInteger(
    env.SIRAGPT_SWARM_MAX_LOGICAL_DEFAULT,
    256,
    8,
    hardLogical,
  );
  return { hardMax, defaultConcurrency, defaultWriters, hardLogical, defaultLogical };
}

async function loadOwnedSwarm(req, res) {
  const swarm = await codexDb.codexSwarm.findFirst({
    where: {
      id: req.params.swarmId,
      projectId: req.params.id,
      userId: req.user.id,
    },
  });
  if (!swarm) {
    res.status(404).json({ error: 'codex_swarm_not_found' });
    return null;
  }
  return swarm;
}

async function commandCenterForProject(project) {
  return require('../services/codex/enterprise-command-center-service')
    .loadEnterpriseCommandCenter({
      prisma: codexDb,
      project,
    });
}

router.get('/projects/:id/command-center', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const state = await commandCenterForProject(project);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      commandCenter: state.commandCenter,
      company: state.company,
    });
  } catch (error) {
    return sendSwarmError(res, error);
  }
});

router.post(
  '/projects/:id/company-operations/research-leads',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyProfile = require('../services/codex/company-operating-profile');
      const companyContext = await companyProfile.loadCompanyOperatingContext({
        prisma: codexDb,
        project,
      });
      const result = await require('../services/codex/company-operations').researchLeads({
        prisma: codexDb,
        project,
        companyContext,
        chatComplete: (args) => require('../services/codex/llm-provider').chatComplete(args),
      });
      return res.json({ result });
    } catch (err) {
      return sendCompanyOperationsError(res, err);
    }
  },
);

router.post(
  '/projects/:id/company-operations/triage-inbox',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyContext = await require('../services/codex/company-operating-profile')
        .loadCompanyOperatingContext({ prisma: codexDb, project });
      const result = await require('../services/codex/company-operations').triageInbox({
        prisma: codexDb,
        project,
        companyContext,
        chatComplete: (args) => require('../services/codex/llm-provider').chatComplete(args),
        maxResults: req.body?.maxResults,
      });
      return res.json({ result });
    } catch (err) {
      return sendCompanyOperationsError(res, err);
    }
  },
);

router.post(
  '/projects/:id/company-operations/triage-social',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyContext = await require('../services/codex/company-operating-profile')
        .loadCompanyOperatingContext({ prisma: codexDb, project });
      const result = await require('../services/codex/company-operations').triageSocialConversations({
        prisma: codexDb,
        project,
        companyContext,
        chatComplete: (args) => require('../services/codex/llm-provider').chatComplete(args),
        maxResults: req.body?.maxResults,
      });
      return res.json({ result });
    } catch (err) {
      return sendCompanyOperationsError(res, err);
    }
  },
);

router.patch('/projects/:id/company-operations/leads/:leadId', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const allowedStatuses = new Set([
      'discovered', 'qualified', 'review', 'contacted', 'replied', 'won', 'lost', 'do_not_contact',
    ]);
    const data = {};
    if (typeof req.body?.email === 'string') {
      const email = req.body.email.trim().toLowerCase().slice(0, 320);
      if (email && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(email))) {
        return res.status(400).json({
          error: 'validation_failed',
          message: 'A valid email address is required.',
        });
      }
      data.email = email || null;
    }
    if (typeof req.body?.contactName === 'string') data.contactName = req.body.contactName.trim().slice(0, 180) || null;
    if (allowedStatuses.has(req.body?.status)) data.status = req.body.status;
    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'validation_failed', message: 'No valid lead fields supplied.' });
    }
    const updated = await codexDb.codexCompanyLead.updateMany({
      where: { id: req.params.leadId, projectId: project.id, userId: project.userId },
      data,
    });
    if (!updated?.count) return res.status(404).json({ error: 'lead_not_found' });
    const lead = await codexDb.codexCompanyLead.findFirst({
      where: { id: req.params.leadId, projectId: project.id, userId: project.userId },
    });
    return res.json({ lead });
  } catch (err) {
    return sendCompanyOperationsError(res, err);
  }
});

router.post(
  '/projects/:id/company-operations/leads/:leadId/outreach',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const companyContext = await require('../services/codex/company-operating-profile')
        .loadCompanyOperatingContext({ prisma: codexDb, project });
      const result = await require('../services/codex/company-operations').prepareLeadOutreach({
        prisma: codexDb,
        project,
        leadId: req.params.leadId,
        companyContext,
        chatComplete: (args) => require('../services/codex/llm-provider').chatComplete(args),
      });
      const status = result.action === 'lead_not_found' ? 404 : result.action === 'lead_email_required' ? 409 : 200;
      return res.status(status).json({ result });
    } catch (err) {
      return sendCompanyOperationsError(res, err);
    }
  },
);

router.post(
  '/projects/:id/swarms',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      if (await runService.hasActiveRun({ projectId: project.id, db: codexDb })) {
        return res.status(409).json({
          error: 'run_in_progress',
          message: 'Termina o detén la ejecución activa antes de iniciar el enjambre empresarial.',
        });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const initial = await commandCenterForProject(project);
      const objective = String(
        body.objective
        || initial.company?.profile?.mission
        || project.name,
      ).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 4_000);
      if (!objective) {
        return res.status(400).json({
          error: 'enterprise_swarm_objective_required',
          message: 'Define un objetivo verificable para CEO Office.',
        });
      }
      const concurrencyDefaults = swarmConcurrencyDefaults(process.env);
      const logicalAgents = boundedSwarmInteger(
        body.logicalAgents,
        concurrencyDefaults.defaultLogical,
        8,
        concurrencyDefaults.hardLogical,
      );
      const maxConcurrency = boundedSwarmInteger(
        body.maxConcurrency,
        concurrencyDefaults.defaultConcurrency,
        1,
        concurrencyDefaults.hardMax,
      );
      const maxConcurrentWriters = boundedSwarmInteger(
        body.maxConcurrentWriters,
        concurrencyDefaults.defaultWriters,
        1,
        Math.min(32, maxConcurrency),
      );

      // Stop the legacy ticker before installing the durable plan. This avoids
      // a race with the durable fleet while preserving its settings.
      await require('../services/codex/proactive-engine').setProactive({
        prisma: codexDb,
        projectId: project.id,
        userId: req.user.id,
        enabled: false,
      });

      const { createFleetSwarm } = require('../services/codex/fleet-orchestrator');
      const fleet = await createFleetSwarm({
        prisma: codexDb,
        userId: req.user.id,
        project,
        objective,
        companyPlan: initial.plan,
        explicitTasks: Array.isArray(body.tasks) ? body.tasks : null,
        planner: (args) => require('../services/codex/llm-provider').chatComplete(args),
        // Full logical capacity (up to 10k). Research shards run in parallel;
        // writers remain isolation-capped via maxConcurrentWriters / runCap.
        logicalTasks: logicalAgents,
        maxConcurrency,
        maxConcurrentWriters,
        qaEvery: body.qaEvery,
        model: body.model ? String(body.model).slice(0, 120) : null,
        tier: body.tier ? String(body.tier).slice(0, 80) : null,
        env: process.env,
      });
      const swarm = fleet.swarm;
      try {
        await require('../services/codex/swarm-runner').enqueueSwarm({
          swarmId: swarm.id,
        });
      } catch (queueError) {
        const { CodexSwarmOrchestrator } = require('../services/codex/swarm-orchestrator');
        const orchestrator = new CodexSwarmOrchestrator({ prisma: codexDb });
        await orchestrator.cancelSwarm({
          swarmId: swarm.id,
          reason: 'swarm_queue_unavailable',
        }).catch(() => {});
        throw queueError;
      }
      const state = await commandCenterForProject(project);
      return res.status(202).json({
        swarm: state.commandCenter.swarm,
        commandCenter: state.commandCenter,
      });
    } catch (error) {
      return sendSwarmError(res, error);
    }
  },
);

router.post(
  '/projects/:id/company-operations/actions/:actionId/approve',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const project = await loadOwnedProjectRecord(req, res);
      if (!project) return undefined;
      const result = await require('../services/codex/company-operations').approveExternalAction({
        prisma: codexDb,
        project,
        actionId: req.params.actionId,
      });
      return res.status(result.action === 'not_found' ? 404 : 200).json({ result });
    } catch (err) {
      return sendCompanyOperationsError(res, err);
    }
  },
);

router.post(
  '/projects/:id/swarms/:swarmId/pause',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const swarm = await loadOwnedSwarm(req, res);
      if (!swarm) return undefined;
      const { CodexSwarmOrchestrator } = require('../services/codex/swarm-orchestrator');
      const result = await new CodexSwarmOrchestrator({ prisma: codexDb })
        .pauseSwarm({ swarmId: swarm.id });
      return res.json({ swarm: result.swarm, progress: result.progress });
    } catch (error) {
      return sendSwarmError(res, error);
    }
  },
);

router.post('/projects/:id/company-operations/actions/:actionId/reject', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProjectRecord(req, res);
    if (!project) return undefined;
    const result = await require('../services/codex/company-operations').rejectExternalAction({
      prisma: codexDb,
      project,
      actionId: req.params.actionId,
    });
    return res.json({ result });
  } catch (err) {
    return sendCompanyOperationsError(res, err);
  }
});

router.post(
  '/projects/:id/swarms/:swarmId/resume',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const swarm = await loadOwnedSwarm(req, res);
      if (!swarm) return undefined;
      const { CodexSwarmOrchestrator } = require('../services/codex/swarm-orchestrator');
      const result = await new CodexSwarmOrchestrator({ prisma: codexDb })
        .resumeSwarm({ swarmId: swarm.id });
      await require('../services/codex/swarm-runner').enqueueSwarm({
        swarmId: swarm.id,
      });
      return res.json({ swarm: result.swarm, progress: result.progress });
    } catch (error) {
      return sendSwarmError(res, error);
    }
  },
);

router.post(
  '/projects/:id/swarms/:swarmId/cancel',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      const swarm = await loadOwnedSwarm(req, res);
      if (!swarm) return undefined;
      const { CodexSwarmOrchestrator } = require('../services/codex/swarm-orchestrator');
      const orchestrator = new CodexSwarmOrchestrator({ prisma: codexDb });
      const result = await orchestrator.cancelSwarm({
        swarmId: swarm.id,
        reason: String(req.body?.reason || 'cancelled_by_user').slice(0, 2_000),
      });

      const integrators = await codexDb.codexSwarmTask.findMany({
        where: { swarmId: swarm.id, role: 'integrator' },
        select: { result: true },
      });
      const planRunIds = integrators
        .map((task) => task.result?.planRunId)
        .filter(Boolean);
      const linkedRuns = planRunIds.length
        ? await codexDb.codexRun.findMany({
          where: {
            userId: req.user.id,
            OR: [
              { id: { in: planRunIds } },
              { planRunId: { in: planRunIds } },
            ],
            status: { in: runService.ACTIVE_STATUSES },
          },
          select: { id: true },
        })
        : [];
      await Promise.allSettled(linkedRuns.map((run) => (
        runService.cancelRun({
          userId: req.user.id,
          runId: run.id,
          db: codexDb,
        })
      )));
      return res.json({ swarm: result.swarm, progress: result.progress });
    } catch (error) {
      return sendSwarmError(res, error);
    }
  },
);

function sendPublicationError(res, err) {
  const status = Number(err?.status) || 500;
  return res.status(status).json({
    error: err?.code || 'codex_publication_failed',
    message: String(err?.message || 'Publication failed').slice(0, 2_000),
  });
}

router.get('/projects/:id/publication', authenticateToken, async (req, res) => {
  try {
    const publication = await publicationService.getPublication({
      userId: req.user.id,
      projectId: req.params.id,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ publication });
  } catch (err) {
    return sendPublicationError(res, err);
  }
});

router.post('/projects/:id/publication', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  const checkpointId = req.body?.checkpointId == null ? null : String(req.body.checkpointId).trim();
  if (checkpointId != null && (!checkpointId || checkpointId.length > 180)) {
    return res.status(400).json({ error: 'checkpoint_id_invalid' });
  }
  try {
    const result = await publicationService.publishProject({
      userId: req.user.id,
      projectId: req.params.id,
      checkpointId,
    });
    return res.status(201).json(result);
  } catch (err) {
    return sendPublicationError(res, err);
  }
});

router.post('/projects/:id/publication/rollback', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  const releaseId = String(req.body?.releaseId || '').trim();
  if (!releaseId || releaseId.length > 180) {
    return res.status(400).json({ error: 'release_id_required' });
  }
  try {
    return res.json(await publicationService.rollbackPublication({
      userId: req.user.id,
      projectId: req.params.id,
      releaseId,
    }));
  } catch (err) {
    return sendPublicationError(res, err);
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

async function loadOwnedProjectRecord(req, res) {
  const project = await codexDb.codexProject.findFirst({
    where: { id: req.params.id, userId: req.user.id, deletedAt: null },
  }).catch(() => null);
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
    const runner = createSandboxClient();
    // REUSE a live dev server before minting anything: the tokenized base is
    // baked into Vite's --base, so restarting re-mints it and instantly 404s
    // ("public base URL" error) every asset URL an already-open iframe holds —
    // two viewers or a start racing an auto-run left the preview blank. Only
    // reuse while the embedded token is still comfortably valid.
    const live = await runner.devStatus(project.id).catch(() => null);
    const liveBase = String(live?.basePath || '');
    const liveToken = /\/preview\/([^/]+)\/app\/$/.exec(liveBase)?.[1];
    const livePayload = liveToken ? verifyPreviewToken(decodeURIComponent(liveToken)) : null;
    const tokenFreshMs = Number(livePayload?.exp || 0) - Date.now();
    if (live?.running && livePayload && livePayload.projectId === project.id && tokenFreshMs > 10 * 60 * 1000) {
      if (Number.isInteger(live.port)) previewPortCache.set(project.id, { port: live.port, ts: Date.now() });
      const previewStatus = live.ready ? live : await waitForRunnerPreviewReady(runner, project.id);
      return res.json({ ok: true, reused: true, port: live.port, project: project.id, previewStatus, devUrl: liveBase, previewUrl: liveBase, basePath: liveBase });
    }
    const token = previewTokenFor({ projectId: project.id, userId: req.user.id });
    const basePath = codexPreviewBasePath(project.id, token);
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
  // Runner state is volatile. A cached 304 can make the browser reuse a
  // pre-deploy "ready" payload after the sidecar has restarted, leaving the
  // iframe pointed at a dead tokenized preview.
  res.set('Cache-Control', 'no-store');
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createSandboxClient().devStatus(project.id);
    return res.json({ ...out, devUrl: runnerDevUrl(process.env, Number.isInteger(out?.port) ? out.port : null) });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/preview/stop', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    await createSandboxClient().stopDev(project.id);
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
    const out = await createSandboxClient().exportWorkspace(project.id);
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
      path: stripPreviewNonce(req.originalUrl || req.url || '/'),
      headers: fwdHeaders,
    },
    (up) => {
      const nonce = previewNonceFromRequest(req);
      const injectConsole = Boolean(nonce && /text\/html|application\/xhtml\+xml/i.test(String(up.headers['content-type'] || '')) && !up.headers['content-encoding']);
      const headers = filterPreviewResponseHeaders(up.headers);
      if (injectConsole) delete headers['content-length'];
      if (injectConsole) {
        readPreviewBody(up).then((body) => {
          const injected = injectPreviewConsoleBridge(body.toString('utf8'), nonce);
          headers['content-length'] = String(Buffer.byteLength(injected));
          res.writeHead(up.statusCode || 502, headers);
          res.end(injected);
        }).catch((err) => {
          upstream.destroy();
          if (!res.headersSent) {
            const status = err?.code === 'preview_html_too_large' ? 413 : 502;
            const error = err?.code === 'preview_html_too_large' ? 'preview_html_too_large' : 'runner_stream_failed';
            res.status(status).json({ error, message: status === 413 ? 'Preview HTML exceeds the injection limit.' : 'El dev server interrumpió la respuesta.' });
          } else {
            try { res.end(); } catch (_) { /* already closed */ }
          }
        });
        return;
      }
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
    const out = await createSandboxClient().exec(project.id, ['git', 'ls-files', '-co', '--exclude-standard']);
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
      await createSandboxClient().writeFiles(project.id, files);
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
    const out = await createSandboxClient().readFile(project.id, path);
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
    body('autoExecute').optional().isBoolean(),
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
        autoExecute: req.body.autoExecute === true,
      });
      return res.status(201).json({ run });
    } catch (err) {
      return mapRunError(err, res);
    }
  },
);

router.get('/projects/:projectId/runs', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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

async function requireOwnedScopedRun(req, res) {
  const run = await runService.getRun({ userId: req.user.id, runId: req.params.runId });
  if (!run || run.projectId !== req.params.projectId) {
    res.status(404).json({ error: 'run_not_found' });
    return null;
  }
  return run;
}

router.get('/projects/:projectId/runs/:runId/transcript', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!await requireOwnedScopedRun(req, res)) return undefined;
    const { service } = codexSessionRuntime();
    const transcript = await service.readTranscript({
      projectId: req.params.projectId,
      sessionId: req.params.runId,
      afterSeq: Math.max(0, Number.parseInt(req.query.afterSeq, 10) || 0),
      limit: Math.max(1, Math.min(500, Number.parseInt(req.query.limit, 10) || 200)),
    });
    return res.json({ transcript });
  } catch (error) {
    return mapSessionError(error, res);
  }
});

router.post(
  '/projects/:projectId/runs/:runId/session/continue',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      if (!await requireOwnedScopedRun(req, res)) return undefined;
      const { service } = codexSessionRuntime();
      const session = await service.continueSession({
        projectId: req.params.projectId,
        sessionId: req.params.runId,
        afterSeq: req.body?.afterSeq == null ? null : Math.max(0, Number(req.body.afterSeq) || 0),
        limit: Math.max(1, Math.min(500, Number(req.body?.limit) || 200)),
      });
      return res.json({ session });
    } catch (error) {
      return mapSessionError(error, res);
    }
  },
);

router.post(
  '/projects/:projectId/runs/:runId/session/fork',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    try {
      if (!await requireOwnedScopedRun(req, res)) return undefined;
      const { service } = codexSessionRuntime();
      const targetSessionId = `fork-${crypto.randomUUID()}`;
      const session = await service.forkSession({
        projectId: req.params.projectId,
        sourceSessionId: req.params.runId,
        targetSessionId,
        atSeq: req.body?.atSeq == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(req.body.atSeq) || 0),
      });
      return res.status(201).json({ session });
    } catch (error) {
      return mapSessionError(error, res);
    }
  },
);

router.post(
  '/projects/:projectId/runs/:runId/session/rewind',
  authenticateToken,
  requireCodexAgentAccess,
  async (req, res) => {
    const toSeq = Number(req.body?.toSeq);
    if (!Number.isSafeInteger(toSeq) || toSeq < 0) {
      return res.status(400).json({ error: 'invalid_rewind_cursor' });
    }
    try {
      const ownedRun = await requireOwnedScopedRun(req, res);
      if (!ownedRun) return undefined;
      const activeStatuses = new Set(['queued', 'running', 'waiting_approval']);
      const projectRuns = await runService.listRuns({
        userId: req.user.id,
        projectId: req.params.projectId,
      });
      if (activeStatuses.has(ownedRun.status) || projectRuns.some((run) => activeStatuses.has(run.status))) {
        return res.status(409).json({ error: 'rewind_run_active' });
      }
      const { runner, service } = codexSessionRuntime();
      const checkpointId = req.body?.checkpointId == null ? null : String(req.body.checkpointId).trim();
      let previousSha = null;
      let checkpointRecoveryRef = null;
      const session = await service.rewindSession({
        projectId: req.params.projectId,
        sessionId: req.params.runId,
        toSeq,
        checkpointId,
        restoreCheckpoint: checkpointId
          ? async () => {
            const restored = await checkpointService.rollbackCheckpoint({
              checkpointId,
              userId: req.user.id,
              projectId: req.params.projectId,
              runId: req.params.runId,
              deps: { runner },
            });
            previousSha = restored?.previousSha || null;
            checkpointRecoveryRef = restored?.recovery?.ref || null;
            return restored?.error ? { ok: false, ...restored } : { ok: true, ...restored };
          }
          : null,
        undoCheckpointRestore: checkpointId
          ? async () => {
            if (checkpointRecoveryRef) {
              return checkpointService.recoverWorkspaceChanges({
                projectId: req.params.projectId,
                recoveryRef: checkpointRecoveryRef,
                runner,
              });
            }
            return previousSha
              ? checkpointService.restoreWorkspaceSha({
                projectId: req.params.projectId,
                commitSha: previousSha,
                deps: { runner },
              })
              : { ok: false, error: 'previous_sha_unavailable' };
          }
          : null,
      });
      return res.json({ session });
    } catch (error) {
      return mapSessionError(error, res);
    }
  },
);

router.post('/runs/:id/cancel', authenticateToken, requireCodexAgentAccess, async (req, res) => {
  try {
    const run = await runService.cancelRun({ userId: req.user.id, runId: req.params.id });
    return res.json({ run });
  } catch (err) {
    return mapRunError(err, res);
  }
});

router.post(
  '/runs/:id/summary-audio',
  authenticateToken,
  requireCodexAgentAccess,
  requirePaidPlan({ feature: 'voice_generation' }),
  async (req, res) => {
    try {
      const result = await require('../services/codex/run-summary-audio').ensureRunSummaryAudio({
        runId: req.params.id,
        userId: req.user.id,
        prisma: codexDb,
        runService,
        eventStore,
        tts: require('../services/ai/elevenlabs-tts'),
      });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(result);
    } catch (err) {
      return res.status(Number(err?.status) || 500).json({
        error: err?.code || 'codex_summary_audio_failed',
        message: err.message,
      });
    }
  },
);

router.post(
  '/runs/:id/tool-permission',
  authenticateToken,
  requireCodexAgentAccess,
  [
    body('permissionId').isString().isLength({ min: 3, max: 240 }),
    body('decision').isString().isIn(['allow', 'deny']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const run = await runService.resolveToolPermission({
        userId: req.user.id,
        runId: req.params.id,
        permissionId: req.body.permissionId,
        decision: req.body.decision,
      });
      return res.json({ run });
    } catch (err) {
      return mapRunError(err, res);
    }
  },
);

// ── Checkpoints (feature 07) ────────────────────────────────────────────────
// /checkpoints/* and /projects/:id/checkpoints do not collide with the legacy
// codex-runs router. Ownership is enforced inside checkpoint-service via the
// project relation; the service returns { error, status } which we map here.
router.post('/checkpoints/:id/rollback', authenticateToken, async (req, res) => {
  try {
    const out = await checkpointService.rollbackCheckpoint({
      checkpointId: req.params.id,
      userId: req.user.id,
      deps: { runner: createSandboxClient() },
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error, detail: out.detail });
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/workspace/recover', authenticateToken, async (req, res) => {
  const recoveryRef = String(req.body?.recoveryRef || '').trim();
  if (!checkpointService.isValidRecoveryRef(recoveryRef)) {
    return res.status(400).json({ error: 'invalid_recovery_ref' });
  }
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const runs = await runService.listRuns({ userId: req.user.id, projectId: project.id });
    if (runs.some((run) => runService.ACTIVE_STATUSES?.includes?.(run.status))) {
      return res.status(409).json({ error: 'workspace_recovery_run_active' });
    }
    const out = await checkpointService.recoverWorkspaceChanges({
      projectId: project.id,
      recoveryRef,
      runner: createSandboxClient(),
    });
    if (!out.ok) {
      return res.status(out.status || 400).json({
        error: out.error,
        detail: out.detail,
        files: out.files,
        recoveryRef: out.recoveryRef,
      });
    }
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
      deps: { runner: createSandboxClient() },
    });
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    return res.json(out);
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:projectId/checkpoints', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
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

router.attachPreviewWebSocketProxy = attachPreviewWebSocketProxy;

module.exports = router;
