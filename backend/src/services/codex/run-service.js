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
const autonomousRunPolicy = require('./autonomous-run-policy');
const observabilityMetrics = require('./observability-metrics');

const MODES = ['plan', 'build'];
const ACTIVE_STATUSES = ['queued', 'running', 'waiting_approval'];
const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];
const APPROVABLE_PLAN_STATUSES = ['waiting_approval', 'done'];
const REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];
const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const MAX_CONCURRENT_RUNS_HARD_CAP = 32;

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

// Fixed advisory-lock namespace for "codex project mutation per project" so
// createRun shares the lock with checkpoint rollback/restore and the objId
// cannot collide with other advisory-lock users.
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
async function insertRunGuarded(
  prisma,
  {
    projectId,
    activeWhere,
    data,
    existingWhere = null,
    activeCap = 1,
    validateBeforeInsert = null,
  },
) {
  const enforce = async (client) => {
    if (existingWhere) {
      const existing = await client.codexRun.findFirst({ where: existingWhere });
      if (existing) return { row: existing, created: false };
    }
    if (typeof validateBeforeInsert === 'function') await validateBeforeInsert(client);
    const active = await client.codexRun.count({ where: activeWhere });
    if (active >= activeCap) {
      throw new RunServiceError(
        'run_in_progress',
        `the project already has ${active} active run(s); concurrency cap is ${activeCap}`,
        409,
      );
    }
    return { row: await client.codexRun.create({ data }), created: true };
  };
  const canLock = typeof prisma.$transaction === 'function' && typeof prisma.$queryRawUnsafe === 'function';
  if (!canLock) return enforce(prisma);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
      CODEX_RUN_LOCK_CLASS,
      hashInt32(String(projectId)),
    );
    return enforce(tx);
  });
}

function featureEnabled(env, key) {
  const value = env?.[key];
  if (value != null && String(value).trim() !== '') {
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
  }
  return env?.NODE_ENV === 'production';
}

function explicitlyEnabled(env, key) {
  return /^(1|true|on|yes)$/i.test(String(env?.[key] ?? '').trim());
}

function configuredRunCap(project, env = process.env) {
  if (
    !featureEnabled(env, 'CODEX_RUN_BRANCHES')
    || !featureEnabled(env, 'CODEX_RUN_WORKTREES')
    || !explicitlyEnabled(env, 'CODEX_RUN_CONCURRENCY_ENABLED')
    || !explicitlyEnabled(env, 'CODEX_RUN_OS_ISOLATION_ATTESTED')
  ) {
    return DEFAULT_MAX_CONCURRENT_RUNS;
  }
  const operatorRaw = env?.CODEX_MAX_CONCURRENT_RUNS ?? DEFAULT_MAX_CONCURRENT_RUNS;
  const operatorParsed = Math.trunc(Number(operatorRaw));
  const operatorCap = Number.isFinite(operatorParsed)
    ? Math.min(Math.max(operatorParsed, DEFAULT_MAX_CONCURRENT_RUNS), MAX_CONCURRENT_RUNS_HARD_CAP)
    : DEFAULT_MAX_CONCURRENT_RUNS;
  const raw = project?.brief?.maxConcurrentRuns ?? operatorCap;
  const parsed = Math.trunc(Number(raw));
  const projectCap = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, DEFAULT_MAX_CONCURRENT_RUNS), MAX_CONCURRENT_RUNS_HARD_CAP)
    : operatorCap;
  return Math.min(projectCap, operatorCap);
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
    reasoningEffort: row.reasoningEffort ?? null,
    planRunId: row.planRunId ?? null,
    departmentPoolId: row.departmentPoolId ?? null,
    swarmTaskId: row.swarmTaskId ?? null,
    prompt: row.prompt == null ? null : autonomousRunPolicy.stripAutoExecutePrompt(row.prompt),
    autoExecute: autonomousRunPolicy.isAutoExecutePrompt(row.prompt),
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
 *  - active runs stay below the isolated-worktree concurrency cap
 */
async function createRun({
  userId,
  projectId,
  mode,
  prompt = null,
  model = null,
  tier = null,
  reasoningEffort = null,
  planRunId = null,
  autoExecute = false,
  idempotencyKey = null,
  departmentPoolId = null,
  swarmTaskId = null,
  db = defaultPrisma,
  queue = runQueue,
  eventStore = eventStoreDefault,
  clock = () => new Date(),
  env = process.env,
}) {
  const prisma = requireDb(db);
  if (!MODES.includes(mode)) throw new RunServiceError('invalid_mode', 'mode must be plan or build', 400);
  const normalizeLink = (value, field, max = 200) => {
    if (value == null) return null;
    const normalized = String(value).trim();
    if (!normalized || normalized.length > max) {
      throw new RunServiceError(`invalid_${field}`, `${field} is invalid`, 400);
    }
    return normalized;
  };
  const normalizedIdempotencyKey = normalizeLink(idempotencyKey, 'idempotency_key', 300);
  const requestedDepartmentPoolId = normalizeLink(departmentPoolId, 'department_pool_id');
  const requestedSwarmTaskId = normalizeLink(swarmTaskId, 'swarm_task_id');
  const normalizedReasoningEffort = reasoningEffort == null || String(reasoningEffort).trim() === ''
    ? null
    : String(reasoningEffort).trim().toLowerCase();
  if (normalizedReasoningEffort && !REASONING_EFFORTS.includes(normalizedReasoningEffort)) {
    throw new RunServiceError(
      'invalid_reasoning_effort',
      `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`,
      400,
    );
  }

  const project = await prisma.codexProject.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new RunServiceError('project_not_found', 'project not found', 404);

  let planRun = null;
  if (mode === 'build') {
    if (!planRunId) throw new RunServiceError('plan_run_required', 'build requires planRunId', 400);
    planRun = await prisma.codexRun.findFirst({
      where: { id: planRunId, projectId, userId, mode: 'plan' },
    });
    if (!planRun || !APPROVABLE_PLAN_STATUSES.includes(planRun.status)) {
      throw new RunServiceError('invalid_plan_run', 'planRunId must reference an approvable plan run', 400);
    }
  }
  if (
    planRun?.departmentPoolId
    && requestedDepartmentPoolId
    && requestedDepartmentPoolId !== planRun.departmentPoolId
  ) {
    throw new RunServiceError(
      'run_lineage_mismatch',
      'build continuation cannot change its department pool',
      409,
    );
  }
  if (
    planRun?.swarmTaskId
    && requestedSwarmTaskId
    && requestedSwarmTaskId !== planRun.swarmTaskId
  ) {
    throw new RunServiceError(
      'run_lineage_mismatch',
      'build continuation cannot change its swarm task',
      409,
    );
  }
  let effectiveDepartmentPoolId = requestedDepartmentPoolId || planRun?.departmentPoolId || null;
  const effectiveSwarmTaskId = requestedSwarmTaskId || planRun?.swarmTaskId || null;
  if (effectiveSwarmTaskId) {
    if (!prisma.codexSwarmTask?.findFirst) {
      throw new RunServiceError(
        'swarm_task_store_unavailable',
        'swarm task validation is unavailable',
        503,
      );
    }
    const task = await prisma.codexSwarmTask.findFirst({
      where: { id: effectiveSwarmTaskId, swarm: { projectId } },
      select: { id: true, input: true },
    });
    const taskInput = task?.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? task.input
      : {};
    const taskPoolId = String(taskInput.departmentPoolId || '').trim() || null;
    if (!task || (effectiveDepartmentPoolId && taskPoolId !== effectiveDepartmentPoolId)) {
      throw new RunServiceError(
        'swarm_task_unavailable',
        'swarm task is unavailable for this project and department pool',
        409,
      );
    }
    if (!effectiveDepartmentPoolId && taskPoolId) effectiveDepartmentPoolId = taskPoolId;
  }
  if (effectiveDepartmentPoolId) {
    if (!prisma.codexDepartmentPool?.findFirst) {
      throw new RunServiceError(
        'department_pool_store_unavailable',
        'department pool validation is unavailable',
        503,
      );
    }
    const pool = await prisma.codexDepartmentPool.findFirst({
      where: { id: effectiveDepartmentPoolId, projectId, enabled: true },
      select: { id: true },
    });
    if (!pool) {
      throw new RunServiceError(
        'department_pool_unavailable',
        'department pool is unavailable for this project',
        409,
      );
    }
  }

  // At most one active run per project — EXCEPT a build approving its own
  // waiting_approval plan run (that plan is "active" but the build is its
  // continuation, not a conflict), so exclude the plan being approved.
  const activeWhere = { projectId, status: { in: ACTIVE_STATUSES } };
  if (mode === 'build' && planRunId) activeWhere.id = { not: planRunId };

  const inheritAutoExecute = autoExecute || autonomousRunPolicy.isAutoExecutePrompt(planRun?.prompt);
  const effectiveModel = model == null || String(model).trim() === '' ? planRun?.model || null : model;
  const effectiveTier = tier == null || String(tier).trim() === '' ? planRun?.tier || null : tier;
  const effectiveReasoningEffort = normalizedReasoningEffort || planRun?.reasoningEffort || null;
  const sourcePrompt = prompt == null && inheritAutoExecute ? planRun?.prompt : prompt;
  const storedPrompt = inheritAutoExecute
    ? autonomousRunPolicy.withAutoExecutePrompt(sourcePrompt)
    : sourcePrompt;
  const existingWhere = normalizedIdempotencyKey
    ? { projectId, userId, idempotencyKey: normalizedIdempotencyKey }
    : mode === 'build' && planRunId
      ? { projectId, userId, mode: 'build', planRunId }
      : null;

  const inserted = await insertRunGuarded(prisma, {
    projectId,
    activeWhere,
    existingWhere,
    activeCap: configuredRunCap(project, env),
    validateBeforeInsert: mode === 'build'
      ? async (client) => {
        const latestPlan = await client.codexRun.findFirst({
          where: { id: planRunId, projectId, userId, mode: 'plan' },
        });
        if (!latestPlan || !APPROVABLE_PLAN_STATUSES.includes(latestPlan.status)) {
          throw new RunServiceError(
            'invalid_plan_run',
            'planRunId stopped being approvable before build creation',
            409,
          );
        }
      }
      : null,
    data: {
      projectId,
      userId,
      mode,
      status: 'queued',
      prompt: storedPrompt,
      model: effectiveModel,
      tier: effectiveTier,
      reasoningEffort: effectiveReasoningEffort,
      planRunId,
      idempotencyKey: normalizedIdempotencyKey,
      departmentPoolId: effectiveDepartmentPoolId,
      swarmTaskId: effectiveSwarmTaskId,
    },
  });
  const { row, created } = inserted;

  if (created) {
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
    // Platform telemetry (batch 2). Best-effort; a metrics failure must not fail create.
    try {
      observabilityMetrics.recordRunCreated({ mode: String(row?.mode || 'plan'), clock });
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') console.warn('[codex run-service] telemetry failed:', err?.message || err);
    }
  }

  // A plan is consumed once its build continuation exists. Keeping the plan
  // in waiting_approval made proactive ticks rediscover it forever and return
  // the same idempotent build instead of progressing to the next objective.
  if (mode === 'build' && planRunId) {
    const consumed = await prisma.codexRun.updateMany({
      where: { id: planRunId, projectId, userId, mode: 'plan', status: 'waiting_approval' },
      data: { status: 'done', finishedAt: clock() },
    });
    if (consumed?.count > 0) {
      await eventStore.appendEvent(
        planRunId,
        'run_status',
        { status: 'done', continuationRunId: row.id },
        { prisma },
      ).catch(() => {});
    }
  }

  const fresh = await prisma.codexRun.findUnique({ where: { id: row.id } });
  return publicRun(fresh || row);
}

async function fanoutCancelledRun({
  run,
  queue,
  eventStore,
  prisma,
  triggers,
  abortRun,
  env,
}) {
  await queue.cancelQueuedCodexRun(run.id).catch(() => {});
  try {
    const abort = abortRun || require('./run-processor').abortRun;
    if (typeof abort === 'function') abort(run.id, new Error('codex run cancelled'));
  } catch { /* worker may live in another process; the DB guard still wins */ }
  await eventStore.appendEvent(run.id, 'run_status', { status: 'cancelled' }, { prisma }).catch(() => {});
  await require('./run-completion').publishRunCompletion({
    run,
    status: 'cancelled',
    triggers,
    env,
  });
  await require('./progress-ledger').appendLedgerEntryIfMissing({
    prisma,
    project: { id: run.projectId },
    entry: {
      department: 'interactive',
      runId: run.id,
      outcome: 'cancelled',
      task: String(run.prompt || '').slice(0, 600),
      diffstat: {},
      costUsd: 0,
      acceptance: [],
      learnings: ['Corrida cancelada por el usuario antes de completar el objetivo.'],
      createdAt: new Date().toISOString(),
    },
  }).catch(() => {});
}

/** Cancel a run (cooperative). Emits the single terminal run_status cancelled. */
async function cancelRun({
  userId,
  runId,
  db = defaultPrisma,
  queue = runQueue,
  eventStore = eventStoreDefault,
  triggers = null,
  abortRun = null,
  env = process.env,
}) {
  const prisma = requireDb(db);
  const run = await prisma.codexRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new RunServiceError('run_not_found', 'run not found', 404);
  if (TERMINAL_STATUSES.includes(run.status)) {
    throw new RunServiceError('run_already_terminal', `run is already ${run.status}`, 409);
  }

  // Conditional flip — the processor may have stamped a terminal status between
  // our read above and here. Only cancel (and emit the terminal event) when the
  // run is still active, so we don't overwrite a just-finished done/error status
  // or double-emit run_status.
  const flip = await prisma.codexRun.updateMany({
    where: { id: runId, status: { in: ACTIVE_STATUSES } },
    data: { status: 'cancelled', finishedAt: new Date() },
  });
  if (flip && flip.count > 0) {
    await fanoutCancelledRun({
      run,
      queue,
      eventStore,
      prisma,
      triggers,
      abortRun,
      env,
    });
  }

  const fresh = await prisma.codexRun.findUnique({ where: { id: runId } });
  return publicRun(fresh);
}

/**
 * Atomically cancels a visible run and its plan→build continuation. The same
 * per-project advisory lock used by createRun closes both races: if build
 * creation wins first we cancel the new child; if cancellation wins first the
 * create path revalidates the now-cancelled plan and refuses the child.
 */
async function cancelRunFamily({
  userId,
  runId,
  db = defaultPrisma,
  queue = runQueue,
  eventStore = eventStoreDefault,
  triggers = null,
  abortRun = null,
  env = process.env,
  clock = () => new Date(),
}) {
  const prisma = requireDb(db);
  const root = await prisma.codexRun.findFirst({ where: { id: runId, userId } });
  if (!root) throw new RunServiceError('run_not_found', 'run not found', 404);

  const cancelLocked = async (client) => {
    const currentRoot = await client.codexRun.findFirst({ where: { id: runId, userId } });
    if (!currentRoot) throw new RunServiceError('run_not_found', 'run not found', 404);
    const active = await client.codexRun.findMany({
      where: {
        userId,
        projectId: currentRoot.projectId,
        status: { in: ACTIVE_STATUSES },
        OR: [{ id: runId }, { planRunId: runId }],
      },
    });
    const cancelled = [];
    const finishedAt = clock();
    // A worker does not take this project advisory lock when it stamps its own
    // terminal status. Transition each candidate conditionally and only retain
    // rows whose flip actually won; otherwise a run that became `done` between
    // findMany and updateMany would receive false cancelled events/ledger data.
    // All successful flips still commit atomically inside this transaction.
    for (const run of active) {
      const flip = await client.codexRun.updateMany({
        where: {
          id: run.id,
          userId,
          projectId: currentRoot.projectId,
          status: { in: ACTIVE_STATUSES },
        },
        data: { status: 'cancelled', finishedAt },
      });
      if (flip?.count > 0) {
        cancelled.push({ ...run, status: 'cancelled', finishedAt });
      }
    }
    return cancelled;
  };

  let cancelledRows;
  const canLock = typeof prisma.$transaction === 'function' && typeof prisma.$queryRawUnsafe === 'function';
  if (canLock) {
    cancelledRows = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'WITH _lock AS (SELECT pg_advisory_xact_lock($1::int, $2::int)) SELECT 1::int AS locked FROM _lock',
        CODEX_RUN_LOCK_CLASS,
        hashInt32(String(root.projectId)),
      );
      return cancelLocked(tx);
    });
  } else {
    cancelledRows = await cancelLocked(prisma);
  }

  await Promise.all(cancelledRows.map((run) => fanoutCancelledRun({
    run,
    queue,
    eventStore,
    prisma,
    triggers,
    abortRun,
    env,
  })));
  const family = await prisma.codexRun.findMany({
    where: { userId, projectId: root.projectId, OR: [{ id: runId }, { planRunId: runId }] },
  });
  return {
    runs: family.map(publicRun),
    cancelledRunIds: cancelledRows.map((run) => run.id),
  };
}

/**
 * Resolve a build-tool approval and requeue the SAME run. The latest durable
 * permission request is the authority; arbitrary permission ids or plan runs
 * cannot be resumed through this endpoint.
 */
async function resolveToolPermission({
  userId,
  runId,
  permissionId,
  decision,
  db = defaultPrisma,
  queue = runQueue,
  eventStore = eventStoreDefault,
  clock = () => new Date(),
}) {
  const prisma = requireDb(db);
  if (!['allow', 'deny'].includes(decision)) {
    throw new RunServiceError('invalid_permission_decision', 'decision must be allow or deny', 400);
  }
  const run = await prisma.codexRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new RunServiceError('run_not_found', 'run not found', 404);
  if (run.mode !== 'build' || run.status !== 'waiting_approval') {
    throw new RunServiceError('run_not_waiting_tool_permission', 'build run is not waiting for tool approval', 409);
  }

  const events = await eventStore.listEvents(run.id, { afterSeq: 0, prisma });
  const request = [...events].reverse().find(
    (event) => event?.type === 'tool_permission_required' && event.data?.permissionId === permissionId,
  );
  if (!request) throw new RunServiceError('tool_permission_not_found', 'tool permission request not found', 404);
  const alreadyResolved = events.some(
    (event) =>
      event?.type === 'tool_permission_resolved'
      && event.data?.permissionId === permissionId
      && Number(event.seq) > Number(request.seq),
  );
  if (alreadyResolved) {
    throw new RunServiceError('tool_permission_already_resolved', 'tool permission was already resolved', 409);
  }

  await eventStore.appendEvent(
    run.id,
    'tool_permission_resolved',
    {
      permissionId,
      toolName: request.data.toolName,
      bindingHash: request.data.bindingHash,
      decision,
    },
    { prisma },
  );
  const flip = await prisma.codexRun.updateMany({
    where: { id: run.id, userId, status: 'waiting_approval' },
    data: { status: 'queued', error: null, finishedAt: null },
  });
  if (!flip?.count) throw new RunServiceError('tool_permission_race', 'run changed while resolving permission', 409);
  await eventStore.appendEvent(run.id, 'run_status', { status: 'queued' }, { prisma });

  try {
    const job = await queue.enqueueCodexRun({
      runId: run.id,
      jobId: `${run.id}:permission:${clock().getTime()}`,
    });
    if (job?.id) {
      await prisma.codexRun.update({ where: { id: run.id }, data: { jobId: String(job.id) } });
    }
  } catch (error) {
    // Keep queued: boot recovery will re-enqueue it.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[codex run-service] permission resume enqueue failed:', error?.message || error);
    }
  }
  const fresh = await prisma.codexRun.findUnique({ where: { id: run.id } });
  return publicRun(fresh || { ...run, status: 'queued' });
}

/** True when the project has a queued/running/waiting_approval run. Used by
 *  the workspace-import route so a client can't overwrite files under a live
 *  build (the agent would be editing a tree that mutates beneath it). */
async function hasActiveRun({ projectId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const active = await prisma.codexRun.count({
    where: { projectId, status: { in: ACTIVE_STATUSES } },
  });
  return active > 0;
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
  cancelRunFamily,
  resolveToolPermission,
  getRun,
  listRuns,
  hasActiveRun,
  publicRun,
  publicMetric,
  RunServiceError,
  MODES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_RUNS_HARD_CAP,
  configuredRunCap,
  featureEnabled,
};
