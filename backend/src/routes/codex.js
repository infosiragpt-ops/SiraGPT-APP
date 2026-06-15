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
 *
 * Montaje: en backend/index.js DESPUÉS del router legacy codex-runs (que ya
 * ocupa POST /api/codex/runs y GET /api/codex/runs/:id). Para no sombrear ese
 * flujo en ningún estado del flag, las corridas V2 viven scoped por proyecto
 * (/projects/:id/runs, fase F2) — decisión registrada en docs/codex-agent-ux.md.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isCodexV2Enabled } = require('../services/codex/flags');
const projectService = require('../services/codex/project-service');
const { createRunnerClient, runnerDevUrl, codexExportHostPath } = require('../services/codex/runner-client');
const eventStore = require('../services/codex/event-store');
const runAccess = require('../services/codex/run-access');
const pubsub = require('../services/codex/redis-pubsub');
const runService = require('../services/codex/run-service');
const checkpointService = require('../services/codex/checkpoint-service');

const router = express.Router();

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
router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.removeHeader('ETag');
  res.json({ ok: true, enabled: isCodexV2Enabled() });
});

router.use((req, res, next) => {
  if (!isCodexV2Enabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

router.post(
  '/projects',
  authenticateToken,
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
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().startDev(project.id);
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:id/preview/status', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().devStatus();
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/preview/stop', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    await createRunnerClient().stopDev();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

// Hybrid "export to disk": mirror the project's source to the runner's
// host-bind-mounted EXPORT_DIR so it shows up in a real folder on the user's
// machine. Also fired best-effort after each checkpoint; this route lets the
// user force a fresh mirror and learn the host path.
router.post('/projects/:id/export', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().exportWorkspace(project.id);
    return res.json({ ...out, hostPath: codexExportHostPath(project.id) });
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
  [
    body('mode').isString().bail().isIn(['plan', 'build']).withMessage('mode must be plan or build'),
    body('prompt').optional({ nullable: true }).isString().isLength({ max: 20000 }),
    body('model').optional({ nullable: true }).isString().isLength({ max: 200 }),
    body('tier').optional({ nullable: true }).isString().isLength({ max: 40 }),
    body('planRunId').optional({ nullable: true }).isString().isLength({ max: 64 }),
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

router.post('/runs/:id/cancel', authenticateToken, async (req, res) => {
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
