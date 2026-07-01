/**
 * agent-batch — Run N agent tasks in a single request.
 *
 * POST /api/agent/batch (SSE)
 *   body: {
 *     tasks: [{ goal, model?, maxSteps?, maxRuntimeMs?, files?, chatId? }, ...],
 *     options: { concurrency?, failFast?, timeoutMs? }
 *   }
 *
 * Emits one SSE stream where each task contributes events tagged with
 * its index (`taskIndex`) and external id (`taskId`):
 *
 *   { type: 'batch_meta',  total, concurrency, failFast }
 *   { type: 'started',     taskIndex, taskId, goal }
 *   { type: 'progress',    taskIndex, taskId, event }
 *   { type: 'done',        taskIndex, taskId, result }
 *   { type: 'error',       taskIndex, taskId, error }
 *   { type: 'batch_done',  summary: { ok, failed, cancelled, durationMs } }
 *
 * Cancellation: aborting the HTTP connection (or the runner timing out)
 * propagates an AbortSignal to every in-flight task. Tasks that have
 * not started yet are dropped.
 *
 * The runner is pluggable via `router.INTERNAL.setRunner(fn)` so unit
 * tests can drive the route without a live OpenAI/Redis stack. The
 * default runner delegates to services/agents/agent-task-runner.
 */

const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

const { authenticateToken } = require('../middleware/auth');
const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');
const {
  MAX_SIMULTANEOUS_DOCUMENTS,
} = require('../config/document-batch-limits');

const router = express.Router();

// ── Limits / defaults ─────────────────────────────────────────────
const MAX_TASKS_PER_BATCH = parseInt(process.env.AGENT_BATCH_MAX_TASKS, 10) || 50;
const DEFAULT_CONCURRENCY = parseInt(process.env.AGENT_BATCH_DEFAULT_CONCURRENCY, 10) || 5;
const MAX_CONCURRENCY = parseInt(process.env.AGENT_BATCH_MAX_CONCURRENCY, 10) || 25;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AGENT_BATCH_DEFAULT_TIMEOUT_MS, 10) || 5 * 60 * 1000;
const MAX_TIMEOUT_MS = parseInt(process.env.AGENT_BATCH_MAX_TIMEOUT_MS, 10) || 60 * 60 * 1000;

// ── Pluggable runner ──────────────────────────────────────────────
// `runner(task, ctx)` must return a promise resolving to a JSON-safe
// result object. `ctx.signal` is an AbortSignal that fires when the
// caller cancels (client disconnect, timeout, or fail-fast).
// `ctx.onProgress(event)` lets the runner stream intermediate events.
let _runner = defaultRunner;

function setRunner(fn) {
  _runner = typeof fn === 'function' ? fn : defaultRunner;
}

function getRunner() {
  return _runner;
}

async function defaultRunner(task, ctx) {
  // Lazy-require so tests that swap the runner before the first call
  // never load the heavyweight runner module.
  const runner = require('../services/agents/agent-task-runner');
  const taskId = task.taskId || `batch-${crypto.randomUUID()}`;
  const payload = {
    taskId,
    traceId: ctx.traceId,
    user: ctx.user,
    goal: task.goal,
    displayGoal: task.displayGoal || task.goal,
    systemContract: task.systemContract || '',
    files: Array.isArray(task.files) ? task.files : [],
    chatId: task.chatId || null,
    model: task.model || 'gpt-4o',
    maxSteps: task.maxSteps || 60,
    maxRuntimeMs: task.maxRuntimeMs || ctx.timeoutMs,
  };
  const onAbort = () => {
    // The runner reads its own AbortController internally — best we
    // can do is bubble the abort error, which fail-fast/timeout below
    // already convert into a structured error event.
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await runner.runAgentTaskJob(payload);
    return { taskId, ok: true, result };
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

// ── SSE writer ────────────────────────────────────────────────────
function writeSse(res, event) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

// ── NDJSON writer (one JSON object per line) ──────────────────────
function writeNdjson(res, event) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`${JSON.stringify(event)}\n`);
    return true;
  } catch {
    return false;
  }
}

function pickStreamMode(body) {
  // Accept `stream` at top level or under `options`. `true`/'ndjson' →
  // NDJSON, otherwise the legacy SSE stream is used.
  const raw =
    body && body.stream !== undefined
      ? body.stream
      : body && body.options && body.options.stream !== undefined
        ? body.options.stream
        : undefined;
  if (raw === true) return 'ndjson';
  if (typeof raw === 'string') {
    const v = raw.toLowerCase();
    if (v === 'ndjson' || v === 'jsonl') return 'ndjson';
    if (v === 'sse') return 'sse';
  }
  return 'sse';
}

// ── Task hashing for dedup ────────────────────────────────────────
// Two tasks within the same batch are considered equivalent when the
// fields that drive runner behavior match exactly. We deliberately
// exclude `taskId` (caller-supplied identifier) and `displayGoal`
// (cosmetic) so distinct labels with identical work share results.
function computeTaskHash(task) {
  if (!task || typeof task !== 'object') return null;
  const files = Array.isArray(task.files)
    ? task.files
        .map((f) => {
          if (!f) return '';
          if (typeof f === 'string') return f;
          // Pick stable identifying fields if present.
          return [f.id, f.path, f.name, f.hash, f.size]
            .filter((v) => v !== undefined && v !== null)
            .join(':');
        })
        .filter(Boolean)
        .sort()
    : [];
  const norm = {
    goal: typeof task.goal === 'string' ? task.goal.trim() : '',
    systemContract: task.systemContract || '',
    model: task.model || '',
    chatId: task.chatId || '',
    maxSteps: task.maxSteps || 0,
    maxRuntimeMs: task.maxRuntimeMs || 0,
    files,
  };
  const json = JSON.stringify(norm);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function sanitizeError(err) {
  if (!err) return { message: 'unknown error' };
  if (err.name === 'AbortError') return { message: 'aborted', code: 'aborted' };
  return {
    message: String(err.message || err),
    code: err.code || err.name || 'runner_error',
  };
}

// ── Validation ────────────────────────────────────────────────────
const validators = [
  body('tasks')
    .isArray({ min: 1, max: MAX_TASKS_PER_BATCH })
    .withMessage(`tasks must be an array of 1..${MAX_TASKS_PER_BATCH} items`),
  body('tasks.*.goal')
    .isString().trim().isLength({ min: 3, max: 4000 })
    .withMessage('each task.goal must be 3-4000 chars'),
  body('tasks.*.model').optional().isString(),
  body('tasks.*.chatId').optional().isString(),
  body('tasks.*.maxSteps').optional().isInt({ min: 2, max: 120 }),
  body('tasks.*.maxRuntimeMs').optional().isInt({ min: 1000, max: 7_200_000 }),
  body('tasks.*.files').optional().isArray({ max: MAX_SIMULTANEOUS_DOCUMENTS }),
  body('options').optional().isObject(),
  body('options.concurrency').optional().isInt({ min: 1, max: MAX_CONCURRENCY }),
  body('options.failFast').optional().isBoolean(),
  body('options.timeoutMs').optional().isInt({ min: 1000, max: MAX_TIMEOUT_MS }),
  body('options.dedupe').optional().isBoolean(),
  body('stream').optional().custom((v) => typeof v === 'boolean' || typeof v === 'string'),
  body('options.stream').optional().custom((v) => typeof v === 'boolean' || typeof v === 'string'),
];

function clampConcurrency(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

function clampTimeout(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, n));
}

// ── Route ─────────────────────────────────────────────────────────
router.post('/batch', authenticateToken, enforcePlanQuota({ surface: 'agent.batch' }), validators, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ ok: false, errors: errors.array() });
  }

  const tasks = req.body.tasks;
  const options = req.body.options || {};
  const concurrency = clampConcurrency(options.concurrency);
  const failFast = options.failFast === true;
  const timeoutMs = clampTimeout(options.timeoutMs);
  const dedupe = options.dedupe !== false;
  const traceId = crypto.randomUUID();
  const startedAt = Date.now();
  const streamMode = pickStreamMode(req.body);
  const writeEvent = streamMode === 'ndjson'
    ? (event) => writeNdjson(res, event)
    : (event) => writeSse(res, event);

  // Open the streaming response. NDJSON uses application/x-ndjson with
  // one JSON object per line; SSE uses the legacy text/event-stream.
  res.status(200);
  if (streamMode === 'ndjson') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  } else {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  }
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const masterController = new AbortController();
  const onClientClose = () => masterController.abort();
  req.on('close', onClientClose);

  writeEvent({
    type: 'batch_meta',
    total: tasks.length,
    concurrency,
    failFast,
    timeoutMs,
    traceId,
    stream: streamMode,
    dedupe,
  });

  const summary = { ok: 0, failed: 0, cancelled: 0, deduped: 0 };
  // hash → { leaderIndex, leaderTaskId, promise: Promise<{ result } | { error }> }
  const dedupMap = new Map();
  const runner = getRunner();
  let queueIndex = 0;
  let stopped = false;

  async function runOne(taskIndex) {
    const task = tasks[taskIndex];
    const taskId = task.taskId || `batch-${traceId}-${taskIndex}`;
    writeEvent({ type: 'started', taskIndex, taskId, goal: task.goal });

    const hash = dedupe ? computeTaskHash(task) : null;
    if (hash && dedupMap.has(hash)) {
      const leader = dedupMap.get(hash);
      writeEvent({
        type: 'deduped',
        taskIndex,
        taskId,
        hash,
        leaderIndex: leader.leaderIndex,
        leaderTaskId: leader.leaderTaskId,
      });
      try {
        const outcome = await leader.promise;
        if (outcome.ok) {
          summary.ok++;
          summary.deduped++;
          writeEvent({
            type: 'done',
            taskIndex,
            taskId,
            result: outcome.result,
            deduped: true,
            leaderTaskId: leader.leaderTaskId,
          });
        } else {
          // Leader failed/cancelled — mirror its error for this follower
          // but do not double-count toward fail-fast (the leader already
          // triggered any abort cascade).
          if (outcome.cancelled) summary.cancelled++;
          else summary.failed++;
          writeEvent({
            type: 'error',
            taskIndex,
            taskId,
            error: outcome.error,
            deduped: true,
            leaderTaskId: leader.leaderTaskId,
          });
        }
      } catch (err) {
        // Unexpected: leader's wrapper always resolves. Treat as failure.
        summary.failed++;
        writeEvent({ type: 'error', taskIndex, taskId, error: sanitizeError(err) });
      }
      return;
    }

    const taskController = new AbortController();
    const masterAbort = () => taskController.abort();
    masterController.signal.addEventListener('abort', masterAbort, { once: true });
    const timer = setTimeout(() => taskController.abort(new Error('task timeout')), timeoutMs);

    const ctx = {
      signal: taskController.signal,
      traceId,
      user: { id: req.user?.id, email: req.user?.email },
      timeoutMs,
      onProgress(event) {
        writeEvent({ type: 'progress', taskIndex, taskId, event });
      },
    };

    // Promise that resolves to a normalized outcome so followers can
    // mirror it without re-running. We never reject this wrapper.
    let resolveOutcome;
    const outcomePromise = new Promise((r) => { resolveOutcome = r; });
    if (hash) {
      dedupMap.set(hash, {
        leaderIndex: taskIndex,
        leaderTaskId: taskId,
        promise: outcomePromise,
      });
    }

    try {
      const result = await runner(task, ctx);
      if (masterController.signal.aborted) {
        summary.cancelled++;
        writeEvent({
          type: 'error', taskIndex, taskId,
          error: { message: 'cancelled', code: 'cancelled' },
        });
        resolveOutcome({ ok: false, cancelled: true, error: { message: 'cancelled', code: 'cancelled' } });
        return;
      }
      summary.ok++;
      writeEvent({ type: 'done', taskIndex, taskId, result });
      resolveOutcome({ ok: true, result });
    } catch (err) {
      const aborted = taskController.signal.aborted || err?.name === 'AbortError';
      if (aborted && masterController.signal.aborted) {
        summary.cancelled++;
      } else {
        summary.failed++;
      }
      const errPayload = sanitizeError(err);
      writeEvent({ type: 'error', taskIndex, taskId, error: errPayload });
      resolveOutcome({ ok: false, cancelled: aborted && masterController.signal.aborted, error: errPayload });
      if (failFast && !aborted) {
        stopped = true;
        masterController.abort();
      }
    } finally {
      clearTimeout(timer);
      masterController.signal.removeEventListener('abort', masterAbort);
    }
  }

  async function worker() {
    while (true) {
      if (stopped || masterController.signal.aborted) return;
      const idx = queueIndex++;
      if (idx >= tasks.length) return;
      await runOne(idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    // Account for tasks that never started (fail-fast or client close).
    const dispatched = summary.ok + summary.failed + summary.cancelled;
    const skipped = tasks.length - dispatched;
    if (skipped > 0) summary.cancelled += skipped;

    writeEvent({
      type: 'batch_done',
      summary: { ...summary, durationMs: Date.now() - startedAt, total: tasks.length },
    });
    req.off('close', onClientClose);
    if (!res.writableEnded) res.end();
  }
});

router.INTERNAL = {
  setRunner,
  getRunner,
  defaultRunner,
  pickStreamMode,
  computeTaskHash,
  limits: {
    MAX_TASKS_PER_BATCH,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  },
};

module.exports = router;
