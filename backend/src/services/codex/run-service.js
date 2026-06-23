'use strict';

/**
 * codex/run-service — CRUD + lifecycle gates for runs (feature 05). Creates a
 * run row (`queued`), enqueues the BullMQ job, and persists the jobId; cancels
 * runs cooperatively; reads runs scoped by ownership. Typed RunServiceError
 * carries the HTTP status the route should map. prisma + queue are injectable.
 *
 * cancelRun owns the `run_status cancelled` event (the processor only stamps
 * finishedAt when it later notices the cancellation) so the terminal event is
 * emitted exactly once.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const runQueue = require('./run-queue');
const eventStoreDefault = require('./event-store');

const MODES = ['plan', 'build'];
const ACTIVE_STATUSES = ['queued', 'running', 'waiting_approval'];
const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];
const APPROVABLE_PLAN_STATUSES = ['waiting_approval', 'done'];

class RunServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RunServiceError';
    this.code = code;
    this.status = status;
  }
}

function requireDb(db) {
  if (!db || !db.codexRun || !db.codexProject) throw new Error('database unavailable');
  return db;
}

// Fixed advisory-lock namespace for "codex active run per project" so the
// per-project objId can't collide with other advisory-lock users.
const CODEX_RUN_LOCK_CLASS = 0x0c0de; // 49374

/** Stable signed-int32 hash of a string (FNV-1a) for the advisory-lock objId. */
function hashInt32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * Insert the run row while holding the single-active-run invariant. The
 * count→create pair is a TOCTOU race: two concurrent creates for the same
 * project both count 0 and both insert. On real Postgres we serialize per
 * project with a transaction-scoped advisory lock (auto-released at commit),
 * so concurrent creates for the SAME project queue behind each other while
 * other projects are unaffected. Test doubles (no $transaction/$queryRawUnsafe)
 * fall back to the plain count→create.
 */
async function insertRunGuarded(prisma, { projectId, activeWhere, data }) {
  const enforce = async (client) => {
    const active = await client.codexRun.count({ where: activeWhere });
    if (active > 0) throw new RunServiceError('run_in_progress', 'a run is already active for this project', 409);
    return client.codexRun.create({ data });
  };
  const canLock = typeof prisma.$transaction === 'function' && typeof prisma.$queryRawUnsafe === 'function';
  if (!canLock) return enforce(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      CODEX_RUN_LOCK_CLASS,
      hashInt32(String(projectId)),
    );
    return enforce(tx);
  });
}

/** Public projection — never leaks userId/jobId. */
function publicRun(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    projectId: row.projectId,
    mode: row.mode,
    status: row.status,
    model: row.model ?? null,
    tier: row.tier ?? null,
    planRunId: row.planRunId ?? null,
    prompt: row.prompt ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
  if (row.metric) out.metric = publicMetric(row.metric);
  return out;
}

function publicMetric(m) {
  return {
    timeWorkedMs: m.timeWorkedMs,
    actionsCount: m.actionsCount,
    itemsReadLines: m.itemsReadLines,
    additions: m.additions,
    deletions: m.deletions,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    costUsd: m.costUsd,
    costSource: m.costSource,
    costOriginalUsd: m.costOriginalUsd,
    costAppliedUsd: m.costAppliedUsd,
  };
}

/**
 * Create + enqueue a run. Validations:
 *  - mode ∈ {plan, build}
 *  - project owned by userId (else 404)
 *  - build requires a valid planRunId (plan run of this project, approvable)
 *  - at most one active run per project (else 409 run_in_progress)
 */
async function createRun({
  userId,
  projectId,
  mode,
  prompt = null,
  model = null,
  tier = null,
  planRunId = null,
  db = defaultPrisma,
  queue = runQueue,
}) {
  const prisma = requireDb(db);
  if (!MODES.includes(mode)) throw new RunServiceError('invalid_mode', 'mode must be plan or build', 400);

  const project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new RunServiceError('project_not_found', 'project not found', 404);

  if (mode === 'build') {
    if (!planRunId) throw new RunServiceError('plan_run_required', 'build requires planRunId', 400);
    const planRun = await prisma.codexRun.findFirst({
      where: { id: planRunId, projectId, userId, mode: 'plan' },
    });
    if (!planRun || !APPROVABLE_PLAN_STATUSES.includes(planRun.status)) {
      throw new RunServiceError('invalid_plan_run', 'planRunId must reference an approvable plan run', 400);
    }
  }

  // At most one active run per project — EXCEPT a build approving its own
  // waiting_approval plan run (that plan is "active" but the build is its
  // continuation, not a conflict), so exclude the plan being approved.
  const activeWhere = { projectId, status: { in: ACTIVE_STATUSES } };
  if (mode === 'build' && planRunId) activeWhere.id = { not: planRunId };

  const row = await insertRunGuarded(prisma, {
    projectId,
    activeWhere,
    data: { projectId, userId, mode, status: 'queued', prompt, model, tier, planRunId },
  });

  try {
    const job = await queue.enqueueCodexRun({ runId: row.id });
    if (job?.id) {
      await prisma.codexRun.update({ where: { id: row.id }, data: { jobId: String(job.id) } });
    }
  } catch (err) {
    // Leave the row `queued`; boot-recovery re-enqueues stuck rows. Surface a
    // soft signal but don't fail the create — the run exists and is recoverable.
    if (process.env.NODE_ENV !== 'test') console.warn('[codex run-service] enqueue failed:', err?.message || err);
  }

  const fresh = await prisma.codexRun.findUnique({ where: { id: row.id } });
  return publicRun(fresh || row);
}

/** Cancel a run (cooperative). Emits the single terminal run_status cancelled. */
async function cancelRun({ userId, runId, db = defaultPrisma, queue = runQueue, eventStore = eventStoreDefault }) {
  const prisma = requireDb(db);
  const run = await prisma.codexRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new RunServiceError('run_not_found', 'run not found', 404);
  if (TERMINAL_STATUSES.includes(run.status)) {
    throw new RunServiceError('run_already_terminal', `run is already ${run.status}`, 409);
  }

  await queue.cancelQueuedCodexRun(runId).catch(() => {});
  await prisma.codexRun.update({ where: { id: runId }, data: { status: 'cancelled', finishedAt: new Date() } });
  await eventStore.appendEvent(runId, 'run_status', { status: 'cancelled' }, { prisma }).catch(() => {});

  const fresh = await prisma.codexRun.findUnique({ where: { id: runId } });
  return publicRun(fresh);
}

async function getRun({ userId, runId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await prisma.codexRun.findFirst({ where: { id: runId, userId }, include: { metric: true } });
  return row ? publicRun(row) : null;
}

async function listRuns({ userId, projectId, db = defaultPrisma, take = 50 }) {
  const prisma = requireDb(db);
  // Ownership via the run's denormalised userId; projectId scopes the list.
  const rows = await prisma.codexRun.findMany({
    where: { projectId, userId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(200, take)),
    include: { metric: true },
  });
  return rows.map(publicRun);
}

module.exports = {
  createRun,
  cancelRun,
  getRun,
  listRuns,
  publicRun,
  publicMetric,
  RunServiceError,
  MODES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
};
