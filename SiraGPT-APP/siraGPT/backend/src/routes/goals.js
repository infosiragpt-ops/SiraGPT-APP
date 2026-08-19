'use strict';

/**
 * routes/goals — HTTP surface for persistent `/goal` background runs.
 *
 *   POST   /api/goals                 → create + enqueue a goal run (202)
 *   GET    /api/goals                 → list user's recent runs (filterable)
 *   GET    /api/goals/:id             → fetch a single run snapshot
 *   GET    /api/goals/:id/stream      → SSE replay of the run + live updates
 *   POST   /api/goals/:id/cancel      → cooperative user-initiated cancel
 *
 * The runs themselves are processed by `services/goal-worker.js` (BullMQ
 * consumer) and persisted as `GoalRun` + `GoalRunEvent` rows. This
 * route is a thin shell around the queue + persistence façades — the
 * heavy lifting lives there.
 *
 * Auth: every route requires a valid bearer token. For the SSE
 * endpoint we add a `bearerFromQueryFallback` middleware so the
 * browser EventSource (which can't set headers) can pass `?token=…`.
 */

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const goalQueue = require('../services/goal-queue');
const goalEvents = require('../services/goal-events');
const goalRecovery = require('../services/goal-boot-recovery');

const prisma = (() => {
  try { return require('../config/database'); } catch { return null; }
})();

const router = express.Router();
const adminRouter = express.Router();

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const ALL_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Build a public projection of a GoalRun row. Hides userId + jobId
 * (server-internal concerns) so the chat composer can render the row
 * directly without leaking adjacent rows.
 */
function serializeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    chatId: run.chatId ?? null,
    status: run.status,
    prompt: run.prompt,
    depth: run.depth,
    agentKind: run.agentKind,
    phase: run.phase ?? null,
    papersCount: run.papersCount ?? 0,
    findingsCount: run.findingsCount ?? 0,
    pagesCount: run.pagesCount ?? 0,
    finalReport: run.finalReport ?? null,
    error: run.error ?? null,
    cancelReason: run.cancelReason ?? null,
    createdAt: run.createdAt ?? null,
    startedAt: run.startedAt ?? null,
    updatedAt: run.updatedAt ?? null,
    completedAt: run.completedAt ?? null,
    cancelledAt: run.cancelledAt ?? null,
    failedAt: run.failedAt ?? null,
  };
}

/**
 * Parse the `status` query string into a Set of allowed statuses.
 *
 * Accepts:
 *   - `active`     → queued + running
 *   - `terminal`   → completed + failed + cancelled
 *   - CSV list     → only the listed statuses (filtered to known values)
 *   - empty/null   → all statuses
 */
function parseStatusFilter(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'active') return ACTIVE_STATUSES;
  if (trimmed === 'terminal') return TERMINAL_STATUSES;
  const tokens = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  const filtered = tokens.filter((t) => ALL_STATUSES.has(t));
  return filtered.length ? new Set(filtered) : null;
}

/**
 * Bearer-from-query fallback. EventSource (browser SSE) can't set
 * headers, so when `?token=` is present we copy it into the
 * Authorization header before authenticateToken runs. Header-set
 * tokens take precedence (header > query).
 */
function bearerFromQueryFallback(req, _res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    const token = String(req.query.token);
    if (token.length > 0 && token.length < 8192) {
      req.headers.authorization = `Bearer ${token}`;
    }
  }
  next();
}

// ── POST /api/goals — create + enqueue ────────────────────────────
const createValidators = [
  body('prompt')
    .isString().withMessage('prompt must be a string')
    .trim()
    .isLength({ min: 3, max: 4000 }).withMessage('prompt must be 3-4000 chars'),
  body('depth')
    .optional()
    .isIn(['quick', 'standard', 'deep']).withMessage('depth must be quick|standard|deep'),
  body('chatId')
    .optional({ nullable: true })
    .isString().withMessage('chatId must be a string')
    .isLength({ min: 1, max: 64 }).withMessage('chatId must be 1-64 chars'),
  body('agentKind')
    .optional()
    .isString().withMessage('agentKind must be a string')
    .isLength({ min: 1, max: 32 }).withMessage('agentKind must be 1-32 chars'),
];

router.post('/', authenticateToken, createValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  }
  if (!prisma || !prisma.goalRun) {
    return res.status(503).json({ error: 'persistence_unavailable' });
  }

  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const prompt = String(req.body.prompt).trim();
  const depth = req.body.depth || 'standard';
  const chatId = req.body.chatId ? String(req.body.chatId) : null;
  const agentKind = req.body.agentKind || 'research';

  let created;
  try {
    created = await prisma.goalRun.create({
      data: {
        userId,
        chatId,
        status: 'queued',
        prompt,
        depth,
        agentKind,
      },
    });
  } catch (err) {
    console.error('[goals] create failed:', err?.message || err);
    return res.status(500).json({ error: 'create_failed', message: err?.message || 'unknown' });
  }

  // Best-effort initial info event so the SSE replay always has at
  // least one row to render before the worker picks up the job.
  await goalEvents.appendEvent({
    goalRunId: created.id,
    type: 'info',
    payload: {
      type: 'info',
      message: 'queued',
      prompt: prompt.slice(0, 200),
      depth,
      agentKind,
      at: new Date().toISOString(),
    },
  });

  try {
    await goalQueue.enqueueGoalRun({ goalRunId: created.id });
  } catch (err) {
    // Queue unavailable — leave row in queued status so a sweeper can
    // retry later. Surface the error so the client knows.
    console.warn('[goals] enqueue failed (row left queued):', err?.message || err);
    return res.status(202).json({
      goalRunId: created.id,
      status: created.status,
      depth: created.depth,
      chatId: created.chatId,
      queuedAt: created.createdAt,
      enqueueWarning: err?.message || 'enqueue_failed',
    });
  }

  return res.status(202).json({
    goalRunId: created.id,
    status: created.status,
    depth: created.depth,
    chatId: created.chatId,
    queuedAt: created.createdAt,
  });
});

// ── GET /api/goals — list ─────────────────────────────────────────
const listValidators = [
  query('chatId').optional().isString().isLength({ min: 1, max: 64 }),
  query('status').optional().isString().isLength({ min: 1, max: 256 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
];

router.get('/', authenticateToken, listValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  }
  if (!prisma || !prisma.goalRun) {
    return res.status(503).json({ error: 'persistence_unavailable' });
  }
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const limit = clampInt(req.query.limit, 1, 100, 25);
  const where = { userId };
  if (req.query.chatId) where.chatId = String(req.query.chatId);
  const statusFilter = parseStatusFilter(req.query.status);
  if (statusFilter) where.status = { in: Array.from(statusFilter) };

  try {
    const rows = await prisma.goalRun.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return res.json({ goals: rows.map(serializeRun) });
  } catch (err) {
    console.error('[goals] list failed:', err?.message || err);
    return res.status(500).json({ error: 'list_failed', message: err?.message || 'unknown' });
  }
});

// ── GET /api/goals/:id — fetch one ────────────────────────────────
router.get('/:id', authenticateToken, [param('id').isString().isLength({ min: 1, max: 64 })], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  }
  if (!prisma || !prisma.goalRun) {
    return res.status(503).json({ error: 'persistence_unavailable' });
  }
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const row = await prisma.goalRun.findFirst({ where: { id: String(req.params.id), userId } });
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ goal: serializeRun(row) });
  } catch (err) {
    console.error('[goals] fetch failed:', err?.message || err);
    return res.status(500).json({ error: 'fetch_failed', message: err?.message || 'unknown' });
  }
});

// ── GET /api/goals/:id/stream — SSE replay + live ─────────────────
router.get(
  '/:id/stream',
  bearerFromQueryFallback,
  authenticateToken,
  [param('id').isString().isLength({ min: 1, max: 64 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    }
    if (!prisma || !prisma.goalRun) {
      return res.status(503).json({ error: 'persistence_unavailable' });
    }
    const userId = String(req.user?.id || '');
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const goalRunId = String(req.params.id);
    const initialRun = await prisma.goalRun.findFirst({ where: { id: goalRunId, userId } }).catch(() => null);
    if (!initialRun) return res.status(404).json({ error: 'not_found' });

    const pollMs = Math.max(50, Math.min(5000, parseInt(process.env.GOAL_SSE_POLL_MS || '400', 10) || 400));
    let lastSeq = (() => {
      const raw = req.query?.lastSeq;
      if (raw === undefined || raw === null || raw === '') return -1;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : -1;
    })();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });
    res.on('close', () => { closed = true; });

    function write(event) {
      if (closed || res.writableEnded) return false;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        return true;
      } catch {
        closed = true;
        return false;
      }
    }

    // Initial snapshot so the client renders state immediately.
    write({ type: 'snapshot', run: serializeRun(initialRun) });

    // Heartbeat every 15s to keep proxies + browsers from idling
    // the connection out.
    const heartbeatInterval = setInterval(() => {
      if (!closed) write({ type: 'heartbeat', t: Date.now() });
    }, 15_000);
    if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();

    try {
      // Replay loop. Each iteration: pull events with seq > lastSeq,
      // emit them, advance lastSeq, then poll the parent row to
      // detect terminal status. When terminal: send a final snapshot
      // + `done` event and break.
      let lastRun = initialRun;
      while (!closed) {
        const result = await goalEvents.listEventsSince({ goalRunId, lastSeq, limit: 500 });
        if (!result.ok) {
          write({ type: 'error', message: result.error || result.reason || 'list_failed' });
          break;
        }
        if (result.run) lastRun = result.run;
        for (const ev of result.events) {
          write({
            type: 'event',
            seq: ev.seq,
            eventType: ev.type,
            payload: ev.payload,
            createdAt: ev.createdAt,
          });
          lastSeq = ev.seq;
          if (closed) break;
        }
        if (closed) break;

        const status = lastRun?.status || 'queued';
        if (TERMINAL_STATUSES.has(status)) {
          write({ type: 'snapshot', run: serializeRun(lastRun) });
          write({ type: 'done', status });
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } catch (err) {
      write({ type: 'error', message: err?.message || String(err) });
    } finally {
      clearInterval(heartbeatInterval);
      if (!res.writableEnded) {
        try { res.end(); } catch { /* */ }
      }
    }
  }
);

// ── POST /api/goals/:id/cancel — cooperative cancel ───────────────
const cancelValidators = [
  param('id').isString().isLength({ min: 1, max: 64 }),
  body('reason').optional().isString().isLength({ max: 200 }),
];

router.post('/:id/cancel', authenticateToken, cancelValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  }
  if (!prisma || !prisma.goalRun) {
    return res.status(503).json({ error: 'persistence_unavailable' });
  }
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const goalRunId = String(req.params.id);
  const row = await prisma.goalRun.findFirst({ where: { id: goalRunId, userId } }).catch(() => null);
  if (!row) return res.status(404).json({ error: 'not_found' });

  // First try to remove the job from the queue if it's still waiting.
  // No-op when the worker has already picked it up — the cooperative
  // cancel below handles that case.
  try {
    await goalQueue.cancelQueuedGoalRun(goalRunId);
  } catch (err) {
    // Queue may be unconfigured (no REDIS_URL) — proceed with row flip.
    console.warn('[goals] queue cancel failed (continuing):', err?.message || err);
  }

  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 200) : undefined;
  const result = await goalEvents.markCancelRequested({ goalRunId, reason });
  if (!result.ok) {
    if (result.reason === 'terminal_status') {
      return res.status(409).json({ error: 'already_terminal', status: result.status });
    }
    return res.status(500).json({ error: result.reason || 'cancel_failed', message: result.error || null });
  }

  return res.json({ cancelled: true, status: 'cancelled', reason: result.cancelReason });
});

// ── POST /api/goals/:id/retry — re-run a terminal goal ────────────
// Only terminal goals (completed | failed | cancelled) can be retried.
// Retrying a running goal would race with the worker — return 409 so
// the client can wait/cancel first.
//
// Retry creates a NEW `goal_runs` row copying { userId, chatId,
// prompt, depth, agentKind } from the source. We append paired info
// events linking source ↔ new so the chat's SSE replay surfaces the
// retry chain to the user.
const retryValidators = [
  param('id').isString().isLength({ min: 1, max: 64 }),
];

router.post('/:id/retry', authenticateToken, retryValidators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'validation_failed', details: errors.array() });
  }
  if (!prisma || !prisma.goalRun) {
    return res.status(503).json({ error: 'persistence_unavailable' });
  }
  const userId = String(req.user?.id || '');
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const sourceId = String(req.params.id);
  const source = await prisma.goalRun.findFirst({ where: { id: sourceId, userId } }).catch(() => null);
  if (!source) return res.status(404).json({ error: 'not_found' });

  if (!TERMINAL_STATUSES.has(source.status)) {
    return res.status(409).json({ error: 'not_terminal', currentStatus: source.status });
  }

  let created;
  try {
    created = await prisma.goalRun.create({
      data: {
        userId,
        chatId: source.chatId ?? null,
        status: 'queued',
        prompt: source.prompt,
        depth: source.depth,
        agentKind: source.agentKind,
      },
    });
  } catch (err) {
    console.error('[goals] retry create failed:', err?.message || err);
    return res.status(500).json({ error: 'retry_failed', message: err?.message || 'unknown' });
  }

  // Initial info event on the NEW row pointing back at the source so
  // the new SSE stream renders a "retry of {sourceId}" line first.
  await goalEvents.appendEvent({
    goalRunId: created.id,
    type: 'info',
    payload: {
      type: 'info',
      message: `retry of ${source.id}`,
      sourceGoalRunId: source.id,
      depth: created.depth,
      agentKind: created.agentKind,
      at: new Date().toISOString(),
    },
  });

  // Paired info event on the SOURCE row so any client still attached
  // to the source's stream (or replaying it from history) surfaces the
  // link forward. Best-effort — appendEvent already swallows errors.
  await goalEvents.appendEvent({
    goalRunId: source.id,
    type: 'info',
    payload: {
      type: 'info',
      message: `retried as ${created.id}`,
      retriedAs: created.id,
      at: new Date().toISOString(),
    },
  });

  try {
    await goalQueue.enqueueGoalRun({ goalRunId: created.id });
  } catch (err) {
    // Queue unavailable — leave row in queued status so the boot
    // recovery sweeper can re-enqueue. Surface the warning so the
    // client knows the run won't start until the queue recovers.
    console.warn('[goals] retry enqueue failed (row left queued):', err?.message || err);
    return res.status(202).json({
      goalRunId: created.id,
      sourceGoalRunId: source.id,
      queuedAt: created.createdAt,
      enqueueWarning: err?.message || 'enqueue_failed',
    });
  }

  return res.status(202).json({
    goalRunId: created.id,
    sourceGoalRunId: source.id,
    queuedAt: created.createdAt,
  });
});

// ── Admin observability ───────────────────────────────────────────
const HEALTH_SUBSYSTEM_TIMEOUT_MS = 2000;

/**
 * Run a promise with a hard timeout. Resolves with `fallback` if the
 * promise doesn't settle in time so a single hung subsystem cannot
 * stall the whole admin snapshot.
 */
function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(fallback), timeoutMs);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

async function collectDbStatusCounts() {
  if (!prisma || !prisma.goalRun) {
    return {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      error: 'persistence_unavailable',
    };
  }
  try {
    const [queued, running, completed, failed, cancelled] = await Promise.all([
      prisma.goalRun.count({ where: { status: 'queued' } }),
      prisma.goalRun.count({ where: { status: 'running' } }),
      prisma.goalRun.count({ where: { status: 'completed' } }),
      prisma.goalRun.count({ where: { status: 'failed' } }),
      prisma.goalRun.count({ where: { status: 'cancelled' } }),
    ]);
    return { queued, running, completed, failed, cancelled };
  } catch (err) {
    return {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      error: err?.message || String(err),
    };
  }
}

async function collectQueueHealth() {
  try {
    const health = await goalQueue.getGoalQueueHealth();
    return {
      name: health.queue || goalQueue.getQueueName(),
      counts: health.counts || {
        waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0,
      },
      redisUrlConfigured: Boolean(health.redisUrlConfigured),
    };
  } catch (err) {
    return {
      name: goalQueue.getQueueName(),
      counts: {
        waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0,
      },
      error: err?.message || String(err),
    };
  }
}

adminRouter.get('/health', authenticateToken, requireAdmin, async (req, res) => {
  const config = goalRecovery.readConfig();
  const fallbackQueue = {
    name: goalQueue.getQueueName(),
    counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 },
    error: 'subsystem_timeout',
  };
  const fallbackDb = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    error: 'subsystem_timeout',
  };

  const settled = await Promise.allSettled([
    withTimeout(collectQueueHealth(), HEALTH_SUBSYSTEM_TIMEOUT_MS, fallbackQueue),
    withTimeout(collectDbStatusCounts(), HEALTH_SUBSYSTEM_TIMEOUT_MS, fallbackDb),
    withTimeout(
      goalRecovery.listStuckQueued({
        prisma,
        reenqueueAfterMs: config.reenqueueAfterMs,
        topK: goalRecovery.DEFAULT_TOP_K,
      }),
      HEALTH_SUBSYSTEM_TIMEOUT_MS,
      [],
    ),
    withTimeout(
      goalRecovery.listZombieRunning({
        prisma,
        stallAfterMs: config.stallAfterMs,
        topK: goalRecovery.DEFAULT_TOP_K,
      }),
      HEALTH_SUBSYSTEM_TIMEOUT_MS,
      [],
    ),
  ]);

  const queue = settled[0].status === 'fulfilled' ? settled[0].value : fallbackQueue;
  const db = settled[1].status === 'fulfilled' ? settled[1].value : fallbackDb;
  const stuckQueued = settled[2].status === 'fulfilled' && Array.isArray(settled[2].value)
    ? settled[2].value
    : [];
  const zombieRunning = settled[3].status === 'fulfilled' && Array.isArray(settled[3].value)
    ? settled[3].value
    : [];

  res.json({
    queue,
    db,
    stuckQueued,
    zombieRunning,
    config: {
      reenqueueAfterMs: config.reenqueueAfterMs,
      stallAfterMs: config.stallAfterMs,
      scanIntervalMs: config.scanIntervalMs,
    },
    capturedAt: new Date().toISOString(),
  });
});

module.exports = router;
module.exports.adminRouter = adminRouter;
module.exports._internal = {
  serializeRun,
  parseStatusFilter,
  bearerFromQueryFallback,
  withTimeout,
  collectDbStatusCounts,
  collectQueueHealth,
};
