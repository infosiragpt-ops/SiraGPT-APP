'use strict';

const crypto = require('node:crypto');
const projectBudget = require('./project-budget');

// Logical capacity for enterprise swarms (research shards + writers + QA).
// Runtime parallelism is still capped by maxConcurrency / isolation.
const MAX_LOGICAL_TASKS = 10_000;
const DEFAULT_EFFECTIVE_CONCURRENCY = 64;
const MAX_EFFECTIVE_CONCURRENCY = 256;
const DEFAULT_WRITER_CONCURRENCY = 4;
const MAX_WRITER_CONCURRENCY = 32;
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 15 * 60_000;
const SERIALIZABLE_RETRIES = 4;

const SWARM_STRATEGIES = Object.freeze({
  DAG: 'dag',
  MAP_REDUCE: 'map_reduce',
});

const SWARM_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PAUSED: 'paused',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  COMPLETED_WITH_ERRORS: 'completed_with_errors',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TASK_STATUSES = Object.freeze({
  QUEUED: 'queued',
  BLOCKED: 'blocked',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TASK_ROLES = Object.freeze({
  WRITER: 'writer',
  READ_ONLY: 'read-only',
  REVIEWER: 'reviewer',
  INTEGRATOR: 'integrator',
});

const TASK_STAGES = Object.freeze({
  WORK: 'work',
  MAP: 'map',
  REDUCE: 'reduce',
  INTEGRATE: 'integrate',
});

const VALID_SWARM_STATUSES = new Set(Object.values(SWARM_STATUSES));
const ACTIVE_SWARM_STATUSES = new Set([
  SWARM_STATUSES.QUEUED,
  SWARM_STATUSES.RUNNING,
  SWARM_STATUSES.PAUSED,
  SWARM_STATUSES.CANCELLING,
]);
const TERMINAL_SWARM_STATUSES = new Set([
  SWARM_STATUSES.COMPLETED,
  SWARM_STATUSES.COMPLETED_WITH_ERRORS,
  SWARM_STATUSES.FAILED,
  SWARM_STATUSES.CANCELLED,
]);
const VALID_TASK_STATUSES = new Set(Object.values(TASK_STATUSES));
const TERMINAL_TASK_STATUSES = new Set([
  TASK_STATUSES.SUCCEEDED,
  TASK_STATUSES.FAILED,
  TASK_STATUSES.CANCELLED,
]);
const VALID_TASK_ROLES = new Set(Object.values(TASK_ROLES));
const WRITE_ROLES = new Set([TASK_ROLES.WRITER, TASK_ROLES.INTEGRATOR]);
const VALID_TASK_STAGES = new Set(Object.values(TASK_STAGES));

class CodexSwarmError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'CodexSwarmError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requiredString(value, field, maxLength = 200) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_input',
      `${field} is required.`,
      400,
      { field },
    );
  }
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_input',
      `${field} is invalid or exceeds ${maxLength} characters.`,
      400,
      { field, maxLength },
    );
  }
  return normalized;
}

function integerInRange(value, fallback, min, max, field) {
  const candidate = value == null ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_limit',
      `${field} must be an integer between ${min} and ${max}.`,
      400,
      { field, min, max },
    );
  }
  return candidate;
}

function optionalBudgetLimit(value, field) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_limit',
      `${field} must be null or a number between 0 and 100000.`,
      400,
      { field },
    );
  }
  return parsed;
}

function normalizeClaimBudgetPolicy(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_input',
      'budgetPolicy must be an object.',
      400,
      { field: 'budgetPolicy' },
    );
  }
  return {
    projectDailyBudgetUsd: optionalBudgetLimit(
      value.projectDailyBudgetUsd,
      'budgetPolicy.projectDailyBudgetUsd',
    ),
    companyDailyBudgetUsd: optionalBudgetLimit(
      value.companyDailyBudgetUsd,
      'budgetPolicy.companyDailyBudgetUsd',
    ),
    defaultReservationUsd: optionalBudgetLimit(
      value.defaultReservationUsd ?? 0,
      'budgetPolicy.defaultReservationUsd',
    ),
  };
}

function normalizeJson(value, field) {
  if (value == null) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('not JSON serializable');
    return JSON.parse(encoded);
  } catch {
    throw new CodexSwarmError(
      'codex_swarm_invalid_json',
      `${field} must be JSON serializable.`,
      400,
      { field },
    );
  }
}

function normalizeStrategy(value) {
  const normalized = String(value || SWARM_STRATEGIES.DAG)
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!Object.values(SWARM_STRATEGIES).includes(normalized)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_strategy',
      'strategy must be dag or map_reduce.',
      400,
    );
  }
  return normalized;
}

function normalizeRole(value) {
  const normalized = String(value || TASK_ROLES.READ_ONLY)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!VALID_TASK_ROLES.has(normalized)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_role',
      `role must be one of: ${Array.from(VALID_TASK_ROLES).join(', ')}.`,
      400,
      { role: value },
    );
  }
  return normalized;
}

function normalizeStage(value) {
  const normalized = String(value || TASK_STAGES.WORK).trim().toLowerCase();
  if (!VALID_TASK_STAGES.has(normalized)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_stage',
      `stage must be one of: ${Array.from(VALID_TASK_STAGES).join(', ')}.`,
      400,
      { stage: value },
    );
  }
  return normalized;
}

function normalizeDependencies(value, taskKey) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new CodexSwarmError(
      'codex_swarm_invalid_dependencies',
      `dependsOn for ${taskKey} must be an array of task keys.`,
      400,
      { taskKey },
    );
  }
  const dependencies = value.map((dependency, index) => (
    requiredString(dependency, `${taskKey}.dependsOn[${index}]`, 160)
  ));
  if (new Set(dependencies).size !== dependencies.length) {
    throw new CodexSwarmError(
      'codex_swarm_duplicate_dependency',
      `Task ${taskKey} contains duplicate dependencies.`,
      400,
      { taskKey },
    );
  }
  return dependencies;
}

function normalizeTaskRows(rawTasks, {
  taskLimit,
  idFactory,
  ordinalOffset = 0,
}) {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new CodexSwarmError(
      'codex_swarm_tasks_required',
      'A swarm requires at least one logical task.',
      400,
    );
  }
  if (rawTasks.length > taskLimit || rawTasks.length > MAX_LOGICAL_TASKS) {
    throw new CodexSwarmError(
      'codex_swarm_task_limit',
      `A swarm supports at most ${Math.min(taskLimit, MAX_LOGICAL_TASKS)} logical tasks.`,
      413,
      { count: rawTasks.length, taskLimit: Math.min(taskLimit, MAX_LOGICAL_TASKS) },
    );
  }

  return rawTasks.map((rawTask, index) => {
    const source = rawTask && typeof rawTask === 'object' ? rawTask : {};
    const ordinal = ordinalOffset + index;
    const key = requiredString(source.key, `tasks[${index}].key`, 160);
    const role = normalizeRole(source.role);
    const dependsOn = normalizeDependencies(source.dependsOn, key);
    return {
      id: requiredString(idFactory('task'), `tasks[${index}].id`, 200),
      key,
      ordinal,
      title: requiredString(source.title || key, `tasks[${index}].title`, 300),
      role,
      stage: normalizeStage(source.stage),
      status: dependsOn.length ? TASK_STATUSES.BLOCKED : TASK_STATUSES.QUEUED,
      priority: integerInRange(
        source.priority,
        0,
        -1_000_000,
        1_000_000,
        `tasks[${index}].priority`,
      ),
      dependsOn,
      input: normalizeJson(source.input, `tasks[${index}].input`),
      maxAttempts: integerInRange(
        source.maxAttempts,
        3,
        1,
        20,
        `tasks[${index}].maxAttempts`,
      ),
      attemptCount: 0,
      version: 0,
    };
  });
}

function normalizeTasks(rawTasks, { taskLimit, idFactory }) {
  const tasks = normalizeTaskRows(rawTasks, { taskLimit, idFactory });
  validateTaskGraph(tasks);
  return tasks;
}

function normalizeAdditionalTasks(rawTasks, {
  existingTasks,
  taskLimit,
  idFactory,
}) {
  const current = Array.isArray(existingTasks) ? existingTasks : [];
  const existingKeys = new Set(current.map((task) => task.key));
  const pending = Array.isArray(rawTasks)
    ? rawTasks.filter((task) => !existingKeys.has(String(task?.key || '').trim()))
    : rawTasks;
  if (Array.isArray(pending) && pending.length === 0) {
    return { tasks: [], replayed: true };
  }
  if (current.length + (Array.isArray(pending) ? pending.length : 0) > taskLimit) {
    throw new CodexSwarmError(
      'codex_swarm_task_limit',
      `A swarm supports at most ${taskLimit} logical tasks.`,
      413,
      { count: current.length + pending.length, taskLimit },
    );
  }
  const tasks = normalizeTaskRows(pending, {
    taskLimit: Math.max(0, taskLimit - current.length),
    idFactory,
    ordinalOffset: current.length,
  });
  validateTaskGraph([...current, ...tasks]);
  return { tasks, replayed: false };
}

function validateTaskGraph(tasks) {
  const byKey = new Map();
  for (const task of tasks) {
    if (byKey.has(task.key)) {
      throw new CodexSwarmError(
        'codex_swarm_duplicate_task_key',
        `Task key ${task.key} is duplicated.`,
        400,
        { taskKey: task.key },
      );
    }
    byKey.set(task.key, task);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) {
        throw new CodexSwarmError(
          'codex_swarm_self_dependency',
          `Task ${task.key} cannot depend on itself.`,
          400,
          { taskKey: task.key },
        );
      }
      if (!byKey.has(dependency)) {
        throw new CodexSwarmError(
          'codex_swarm_missing_dependency',
          `Task ${task.key} depends on missing task ${dependency}.`,
          400,
          { taskKey: task.key, dependency },
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (key) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      const cycleStart = stack.indexOf(key);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), key];
      throw new CodexSwarmError(
        'codex_swarm_dependency_cycle',
        `Task dependency cycle detected: ${cycle.join(' -> ')}.`,
        400,
        { cycle },
      );
    }
    visiting.add(key);
    stack.push(key);
    for (const dependency of byKey.get(key).dependsOn) visit(dependency);
    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };

  for (const task of tasks) visit(task.key);
  return true;
}

function validateMapReduceShape(tasks) {
  const mapTasks = tasks.filter((task) => task.stage === TASK_STAGES.MAP);
  const reduceTasks = tasks.filter((task) => task.stage === TASK_STAGES.REDUCE);
  const integrationTasks = tasks.filter((task) => task.stage === TASK_STAGES.INTEGRATE);

  if (!mapTasks.length) {
    throw new CodexSwarmError(
      'codex_swarm_map_tasks_required',
      'A map_reduce swarm requires at least one map task.',
      400,
    );
  }
  if (integrationTasks.length > 1) {
    throw new CodexSwarmError(
      'codex_swarm_multiple_integrators',
      'A map_reduce swarm supports one final integrator task.',
      400,
    );
  }
  for (const task of mapTasks) {
    if (![TASK_ROLES.WRITER, TASK_ROLES.READ_ONLY].includes(task.role)) {
      throw new CodexSwarmError(
        'codex_swarm_invalid_map_role',
        `Map task ${task.key} must be writer or read-only.`,
        400,
      );
    }
  }
  for (const task of reduceTasks) {
    if (!task.dependsOn.length) {
      throw new CodexSwarmError(
        'codex_swarm_reduce_dependencies_required',
        `Reduce task ${task.key} must depend on map output.`,
        400,
      );
    }
  }
  for (const task of integrationTasks) {
    if (task.role !== TASK_ROLES.INTEGRATOR || !task.dependsOn.length) {
      throw new CodexSwarmError(
        'codex_swarm_invalid_integrator',
        'The integration task must use the integrator role and depend on reduced output.',
        400,
      );
    }
  }
}

function buildMapReduceTaskGraph({
  maps,
  reducers = null,
  integrator = null,
} = {}) {
  if (!Array.isArray(maps) || maps.length === 0) {
    throw new CodexSwarmError(
      'codex_swarm_map_tasks_required',
      'maps must contain at least one task.',
      400,
    );
  }

  const mapTasks = maps.map((task, index) => ({
    ...task,
    key: task?.key || `map-${index + 1}`,
    title: task?.title || `Map ${index + 1}`,
    role: task?.role || TASK_ROLES.WRITER,
    stage: TASK_STAGES.MAP,
    dependsOn: task?.dependsOn || [],
  }));
  const mapKeys = mapTasks.map((task) => task.key);

  const reducerSources = reducers == null
    ? [{ key: 'reduce', title: 'Review and reduce map outputs' }]
    : reducers;
  if (!Array.isArray(reducerSources) || reducerSources.length === 0) {
    throw new CodexSwarmError(
      'codex_swarm_reduce_tasks_required',
      'reducers must contain at least one task.',
      400,
    );
  }
  const reduceTasks = reducerSources.map((task, index) => ({
    ...task,
    key: task?.key || `reduce-${index + 1}`,
    title: task?.title || `Reduce ${index + 1}`,
    role: task?.role || TASK_ROLES.REVIEWER,
    stage: TASK_STAGES.REDUCE,
    dependsOn: task?.dependsOn || mapKeys,
  }));
  const reduceKeys = reduceTasks.map((task) => task.key);

  const integrationSource = integrator === false
    ? null
    : (integrator || { key: 'integrate', title: 'Integrate verified changes' });
  const integrationTasks = integrationSource
    ? [{
      ...integrationSource,
      key: integrationSource.key || 'integrate',
      title: integrationSource.title || 'Integrate verified changes',
      role: TASK_ROLES.INTEGRATOR,
      stage: TASK_STAGES.INTEGRATE,
      dependsOn: integrationSource.dependsOn || reduceKeys,
    }]
    : [];

  const graph = [...mapTasks, ...reduceTasks, ...integrationTasks];
  if (graph.length > MAX_LOGICAL_TASKS) {
    throw new CodexSwarmError(
      'codex_swarm_task_limit',
      `A map_reduce graph supports at most ${MAX_LOGICAL_TASKS} logical tasks.`,
      413,
      { count: graph.length, taskLimit: MAX_LOGICAL_TASKS },
    );
  }
  return graph;
}

function aggregateTaskProgress(tasks) {
  const counts = {
    total: tasks.length,
    queued: 0,
    blocked: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  const byRole = {};
  let runningWriters = 0;

  for (const task of tasks) {
    if (!VALID_TASK_STATUSES.has(task.status)) {
      throw new CodexSwarmError(
        'codex_swarm_invalid_persisted_status',
        `Unknown task status ${task.status}.`,
        500,
        { taskId: task.id, status: task.status },
      );
    }
    counts[task.status] += 1;
    byRole[task.role] = (byRole[task.role] || 0) + 1;
    if (task.status === TASK_STATUSES.RUNNING && WRITE_ROLES.has(task.role)) {
      runningWriters += 1;
    }
  }

  const terminal = counts.succeeded + counts.failed + counts.cancelled;
  const progressPercent = counts.total === 0
    ? 100
    : Math.round((terminal / counts.total) * 10_000) / 100;
  return {
    counts,
    byRole,
    terminal,
    progressPercent,
    runningWriters,
  };
}

function deriveSwarmStatus(swarm, aggregate) {
  if (swarm.cancelRequestedAt) return SWARM_STATUSES.CANCELLED;
  if (aggregate.terminal === aggregate.counts.total && aggregate.counts.total > 0) {
    if (aggregate.counts.failed > 0 && aggregate.counts.succeeded === 0) {
      return SWARM_STATUSES.FAILED;
    }
    if (aggregate.counts.failed > 0 || aggregate.counts.cancelled > 0) {
      return SWARM_STATUSES.COMPLETED_WITH_ERRORS;
    }
    return SWARM_STATUSES.COMPLETED;
  }
  if (swarm.status === SWARM_STATUSES.PAUSED) return SWARM_STATUSES.PAUSED;
  if (aggregate.counts.running > 0 || swarm.startedAt) return SWARM_STATUSES.RUNNING;
  return SWARM_STATUSES.QUEUED;
}

function aggregatePatch(swarm, tasks, now) {
  const aggregate = aggregateTaskProgress(tasks);
  const status = deriveSwarmStatus(swarm, aggregate);
  const terminal = TERMINAL_SWARM_STATUSES.has(status);
  return {
    aggregate,
    data: {
      status,
      totalTaskCount: aggregate.counts.total,
      queuedTaskCount: aggregate.counts.queued,
      blockedTaskCount: aggregate.counts.blocked,
      runningTaskCount: aggregate.counts.running,
      succeededTaskCount: aggregate.counts.succeeded,
      failedTaskCount: aggregate.counts.failed,
      cancelledTaskCount: aggregate.counts.cancelled,
      progressPercent: aggregate.progressPercent,
      ...(
        status === SWARM_STATUSES.RUNNING && !swarm.startedAt
          ? { startedAt: now }
          : {}
      ),
      ...(terminal && !swarm.finishedAt ? { finishedAt: now } : {}),
    },
  };
}

function aggregateChanged(swarm, data) {
  return [
    'status',
    'totalTaskCount',
    'queuedTaskCount',
    'blockedTaskCount',
    'runningTaskCount',
    'succeededTaskCount',
    'failedTaskCount',
    'cancelledTaskCount',
    'progressPercent',
  ].some((field) => swarm[field] !== data[field])
    || Boolean(data.startedAt)
    || Boolean(data.finishedAt);
}

function isSerializationConflict(error) {
  return error?.code === 'P2034' || error?.code === 'codex_swarm_claim_conflict';
}

async function withSerializableRetry(prisma, operation) {
  let lastError = null;
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      lastError = error;
      if (!isSerializationConflict(error) || attempt === SERIALIZABLE_RETRIES - 1) throw error;
    }
  }
  throw lastError;
}

async function loadTasks(tx, swarmId) {
  return tx.codexSwarmTask.findMany({
    where: { swarmId },
    orderBy: [{ priority: 'desc' }, { ordinal: 'asc' }],
  });
}

async function persistAggregate(tx, swarm, tasks, now) {
  const { aggregate, data } = aggregatePatch(swarm, tasks, now);
  if (!aggregateChanged(swarm, data)) return { swarm, tasks, aggregate };
  const updated = await tx.codexSwarm.update({
    where: { id: swarm.id },
    data: { ...data, version: { increment: 1 } },
  });
  return { swarm: updated, tasks, aggregate };
}

async function reconcileInTransaction(tx, swarm, now) {
  let tasks = await loadTasks(tx, swarm.id);

  for (const task of tasks) {
    if (
      task.status !== TASK_STATUSES.RUNNING
      || !task.leaseExpiresAt
      || task.leaseExpiresAt.getTime() > now.getTime()
    ) {
      continue;
    }
    const exhausted = task.attemptCount >= task.maxAttempts;
    await tx.codexSwarmTask.updateMany({
      where: {
        id: task.id,
        status: TASK_STATUSES.RUNNING,
        leaseToken: task.leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: exhausted ? TASK_STATUSES.FAILED : TASK_STATUSES.QUEUED,
        claimId: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: now,
        error: exhausted ? 'lease_expired_max_attempts' : null,
        finishedAt: exhausted ? now : null,
        version: { increment: 1 },
      },
    });
  }

  tasks = await loadTasks(tx, swarm.id);
  let changed = true;
  while (changed) {
    changed = false;
    const statusByKey = new Map(tasks.map((task) => [task.key, task.status]));
    for (const task of tasks) {
      if (TERMINAL_TASK_STATUSES.has(task.status) || task.status === TASK_STATUSES.RUNNING) continue;
      const tolerantReducer = (
        task.role === TASK_ROLES.REVIEWER
        && task.stage === TASK_STAGES.REDUCE
      );
      const failedDependency = tolerantReducer ? null : task.dependsOn.find((key) => (
        [TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED].includes(statusByKey.get(key))
      ));
      const dependenciesReady = task.dependsOn.every((key) => {
        const status = statusByKey.get(key);
        return tolerantReducer
          ? TERMINAL_TASK_STATUSES.has(status)
          : status === TASK_STATUSES.SUCCEEDED;
      });
      const desiredStatus = failedDependency
        ? TASK_STATUSES.CANCELLED
        : (dependenciesReady ? TASK_STATUSES.QUEUED : TASK_STATUSES.BLOCKED);
      if (desiredStatus === task.status) continue;

      await tx.codexSwarmTask.updateMany({
        where: { id: task.id, status: task.status },
        data: {
          status: desiredStatus,
          error: failedDependency ? `dependency_failed:${failedDependency}` : null,
          finishedAt: failedDependency ? now : null,
          version: { increment: 1 },
        },
      });
      task.status = desiredStatus;
      task.error = failedDependency ? `dependency_failed:${failedDependency}` : null;
      task.finishedAt = failedDependency ? now : null;
      changed = true;
    }
  }

  tasks = await loadTasks(tx, swarm.id);
  return persistAggregate(tx, swarm, tasks, now);
}

function createPrismaSwarmRepository(prisma) {
  if (
    !prisma
    || typeof prisma.$transaction !== 'function'
    || !prisma.codexSwarm
    || !prisma.codexSwarmTask
  ) {
    throw new CodexSwarmError(
      'codex_swarm_repository_invalid',
      'A Prisma client with CodexSwarm models is required.',
      500,
    );
  }

  return {
    async createSwarm({ swarm, tasks }) {
      return withSerializableRetry(prisma, async (tx) => {
        const project = await tx.codexProject.findFirst({
          where: { id: swarm.projectId, userId: swarm.userId },
          select: { id: true },
        });
        if (!project) {
          throw new CodexSwarmError(
            'codex_swarm_project_not_found',
            'Codex project not found for this user.',
            404,
          );
        }
        const active = await tx.codexSwarm.findFirst({
          where: {
            projectId: swarm.projectId,
            status: { in: Array.from(ACTIVE_SWARM_STATUSES) },
          },
          select: { id: true },
        });
        if (active) {
          throw new CodexSwarmError(
            'codex_swarm_in_progress',
            'An enterprise swarm is already active for this project.',
            409,
            { swarmId: active.id },
          );
        }
        await tx.codexSwarm.create({ data: swarm });
        await tx.codexSwarmTask.createMany({
          data: tasks.map((task) => ({
            ...task,
            swarmId: swarm.id,
            ...(task.input == null ? {} : { input: task.input }),
          })),
        });
        return tx.codexSwarm.findUnique({
          where: { id: swarm.id },
          include: { tasks: { orderBy: { ordinal: 'asc' } } },
        });
      });
    },

    async appendTasks({
      swarmId,
      rawTasks,
      idFactory,
      now,
    }) {
      return withSerializableRetry(prisma, async (tx) => {
        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.cancelRequestedAt) {
          throw new CodexSwarmError(
            'codex_swarm_terminal',
            'Tasks cannot be appended to a terminal or cancelling swarm.',
            409,
            { swarmId, status: swarm.status },
          );
        }
        const existingTasks = await loadTasks(tx, swarmId);
        const normalized = normalizeAdditionalTasks(rawTasks, {
          existingTasks,
          taskLimit: swarm.taskLimit,
          idFactory,
        });
        if (normalized.tasks.length) {
          await tx.codexSwarmTask.createMany({
            data: normalized.tasks.map((task) => ({
              ...task,
              swarmId,
              ...(task.input == null ? {} : { input: task.input }),
            })),
          });
        }
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        swarm = reconciled.swarm;
        return {
          swarm,
          tasks: reconciled.tasks,
          progress: reconciled.aggregate,
          appended: normalized.tasks,
          replayed: normalized.replayed,
        };
      });
    },

    async getSwarm(swarmId) {
      return prisma.codexSwarm.findUnique({ where: { id: swarmId } });
    },

    async claimTask({
      swarmId,
      workerId,
      claimId,
      leaseToken,
      now,
      leaseExpiresAt,
      budgetPolicy,
    }) {
      const claim = async () => withSerializableRetry(prisma, async (tx) => {
        const existingBeforeReconcile = await tx.codexSwarmTask.findUnique({
          where: { claimId },
        });
        if (
          existingBeforeReconcile
          && (
            existingBeforeReconcile.swarmId !== swarmId
            || existingBeforeReconcile.leaseOwner !== workerId
          )
        ) {
          throw new CodexSwarmError(
            'codex_swarm_claim_id_conflict',
            'claimId is already owned by another worker or swarm.',
            409,
          );
        }

        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        let reconciled = await reconcileInTransaction(tx, swarm, now);
        swarm = reconciled.swarm;
        let tasks = reconciled.tasks;

        if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.cancelRequestedAt) {
          return { task: null, replayed: false, reason: 'swarm_terminal' };
        }
        if (swarm.status === SWARM_STATUSES.PAUSED) {
          return { task: null, replayed: false, reason: 'swarm_paused' };
        }

        if (existingBeforeReconcile) {
          const existing = await tx.codexSwarmTask.findUnique({
            where: { id: existingBeforeReconcile.id },
          });
          if (
            !existing
            || existing.status !== TASK_STATUSES.RUNNING
            || existing.leaseOwner !== workerId
            || existing.leaseToken !== existingBeforeReconcile.leaseToken
            || !existing.leaseExpiresAt
            || existing.leaseExpiresAt.getTime() <= now.getTime()
          ) {
            throw new CodexSwarmError(
              'codex_swarm_claim_expired',
              'The replayed claim no longer owns an active lease.',
              409,
            );
          }
          if (budgetPolicy) {
            const admission = await projectBudget.checkSwarmClaimBudget({
              prisma: tx,
              projectId: swarm.projectId,
              task: existing,
              projectDailyBudgetUsd: budgetPolicy.projectDailyBudgetUsd,
              companyDailyBudgetUsd: budgetPolicy.companyDailyBudgetUsd,
              defaultReservationUsd: budgetPolicy.defaultReservationUsd,
              now,
            });
            if (!admission.allowed) {
              const released = await tx.codexSwarmTask.updateMany({
                where: {
                  id: existing.id,
                  swarmId,
                  status: TASK_STATUSES.RUNNING,
                  leaseOwner: workerId,
                  leaseToken: existing.leaseToken,
                  leaseExpiresAt: { gt: now },
                },
                data: {
                  status: TASK_STATUSES.QUEUED,
                  claimId: null,
                  leaseOwner: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  claimedAt: null,
                  lastHeartbeatAt: now,
                  error: `claim_replay_deferred:${admission.reason}`,
                  finishedAt: null,
                  attemptCount: { decrement: 1 },
                  version: { increment: 1 },
                },
              });
              if (released.count !== 1) {
                throw new CodexSwarmError(
                  'codex_swarm_lease_conflict',
                  'The replayed claim changed before it could be deferred.',
                  409,
                );
              }
              swarm = await tx.codexSwarm.update({
                where: { id: swarmId },
                data: {
                  status: SWARM_STATUSES.PAUSED,
                  version: { increment: 1 },
                },
              });
              reconciled = await reconcileInTransaction(tx, swarm, now);
              tasks = reconciled.tasks;
              return {
                task: null,
                replayed: false,
                reason: admission.reason,
                budget: admission,
              };
            }
          }
          return { task: existing, replayed: true, reason: null };
        }

        const running = tasks.filter((task) => (
          task.status === TASK_STATUSES.RUNNING
          && task.leaseExpiresAt
          && task.leaseExpiresAt.getTime() > now.getTime()
        ));
        if (running.length >= swarm.maxConcurrency) {
          return { task: null, replayed: false, reason: 'concurrency_limit' };
        }
        const activeWriters = running.filter((task) => WRITE_ROLES.has(task.role)).length;
        const candidates = tasks
          .filter((task) => task.status === TASK_STATUSES.QUEUED)
          .sort((left, right) => right.priority - left.priority || left.ordinal - right.ordinal);
        const task = candidates.find((candidate) => (
          !WRITE_ROLES.has(candidate.role) || activeWriters < swarm.maxConcurrentWriters
        ));
        if (!task) {
          const writerWaiting = candidates.some((candidate) => WRITE_ROLES.has(candidate.role));
          return {
            task: null,
            replayed: false,
            reason: writerWaiting ? 'writer_concurrency_limit' : 'no_ready_tasks',
          };
        }

        if (budgetPolicy) {
          const admission = await projectBudget.checkSwarmClaimBudget({
            prisma: tx,
            projectId: swarm.projectId,
            task,
            projectDailyBudgetUsd: budgetPolicy.projectDailyBudgetUsd,
            companyDailyBudgetUsd: budgetPolicy.companyDailyBudgetUsd,
            defaultReservationUsd: budgetPolicy.defaultReservationUsd,
            now,
          });
          if (!admission.allowed) {
            swarm = await tx.codexSwarm.update({
              where: { id: swarmId },
              data: {
                status: SWARM_STATUSES.PAUSED,
                version: { increment: 1 },
              },
            });
            await persistAggregate(tx, swarm, tasks, now);
            return {
              task: null,
              replayed: false,
              reason: admission.reason,
              budget: admission,
            };
          }
        }

        const claimed = await tx.codexSwarmTask.updateMany({
          where: {
            id: task.id,
            swarmId,
            status: TASK_STATUSES.QUEUED,
            claimId: null,
            attemptCount: task.attemptCount,
          },
          data: {
            status: TASK_STATUSES.RUNNING,
            claimId,
            leaseOwner: workerId,
            leaseToken,
            leaseExpiresAt,
            claimedAt: now,
            lastHeartbeatAt: now,
            startedAt: task.startedAt || now,
            attemptCount: { increment: 1 },
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) {
          const conflict = new Error('Task changed while it was being claimed.');
          conflict.code = 'codex_swarm_claim_conflict';
          throw conflict;
        }

        const claimedTask = await tx.codexSwarmTask.findUnique({ where: { id: task.id } });
        const refreshedTasks = tasks.map((candidate) => (
          candidate.id === claimedTask.id ? claimedTask : candidate
        ));
        await persistAggregate(tx, swarm, refreshedTasks, now);
        return { task: claimedTask, replayed: false, reason: null };
      });

      try {
        return await claim();
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
        // Re-enter the full transactional path so the winner's claim is
        // reconciled and revalidated against swarm state and budget policy.
        return claim();
      }
    },

    async renewLease({
      swarmId,
      taskId,
      workerId,
      leaseToken,
      now,
      leaseExpiresAt,
    }) {
      return withSerializableRetry(prisma, async (tx) => {
        const task = await tx.codexSwarmTask.findFirst({
          where: { id: taskId, swarmId },
        });
        if (!task) {
          throw new CodexSwarmError(
            'codex_swarm_task_not_found',
            'Codex swarm task not found.',
            404,
          );
        }
        if (
          task.status !== TASK_STATUSES.RUNNING
          || task.leaseOwner !== workerId
          || task.leaseToken !== leaseToken
        ) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task lease is not owned by this worker.',
            409,
          );
        }
        if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
          throw new CodexSwarmError(
            'codex_swarm_lease_expired',
            'The task lease has expired.',
            409,
          );
        }
        const renewed = await tx.codexSwarmTask.updateMany({
          where: {
            id: task.id,
            status: TASK_STATUSES.RUNNING,
            leaseOwner: workerId,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            leaseExpiresAt,
            lastHeartbeatAt: now,
            version: { increment: 1 },
          },
        });
        if (renewed.count !== 1) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task lease changed concurrently.',
            409,
          );
        }
        return tx.codexSwarmTask.findUnique({ where: { id: task.id } });
      });
    },

    async deferTask({
      swarmId,
      taskId,
      workerId,
      leaseToken,
      reason,
      now,
    }) {
      return withSerializableRetry(prisma, async (tx) => {
        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        if (TERMINAL_SWARM_STATUSES.has(swarm.status)) {
          throw new CodexSwarmError(
            'codex_swarm_terminal',
            `Swarm already finished with status ${swarm.status}.`,
            409,
          );
        }
        const task = await tx.codexSwarmTask.findFirst({
          where: { id: taskId, swarmId },
        });
        if (!task) {
          throw new CodexSwarmError(
            'codex_swarm_task_not_found',
            'Codex swarm task not found.',
            404,
          );
        }
        if (
          task.status !== TASK_STATUSES.RUNNING
          || task.leaseOwner !== workerId
          || task.leaseToken !== leaseToken
        ) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task lease is not owned by this worker.',
            409,
          );
        }
        if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
          throw new CodexSwarmError(
            'codex_swarm_lease_expired',
            'The task lease expired before it could be deferred.',
            409,
          );
        }

        if (swarm.status !== SWARM_STATUSES.PAUSED) {
          swarm = await tx.codexSwarm.update({
            where: { id: swarmId },
            data: {
              status: SWARM_STATUSES.PAUSED,
              version: { increment: 1 },
            },
          });
        }
        const deferred = await tx.codexSwarmTask.updateMany({
          where: {
            id: task.id,
            swarmId,
            status: TASK_STATUSES.RUNNING,
            leaseOwner: workerId,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            status: TASK_STATUSES.QUEUED,
            claimId: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            claimedAt: null,
            lastHeartbeatAt: now,
            error: reason,
            finishedAt: null,
            attemptCount: { decrement: 1 },
            version: { increment: 1 },
          },
        });
        if (deferred.count !== 1) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task changed concurrently before it could be deferred.',
            409,
          );
        }
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        return {
          task: reconciled.tasks.find((candidate) => candidate.id === task.id),
          swarm: reconciled.swarm,
          progress: reconciled.aggregate,
          replayed: false,
        };
      });
    },

    async finishTask({
      swarmId,
      taskId,
      workerId,
      leaseToken,
      status,
      result,
      error,
      now,
    }) {
      return withSerializableRetry(prisma, async (tx) => {
        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        const task = await tx.codexSwarmTask.findFirst({
          where: { id: taskId, swarmId },
        });
        if (!task) {
          throw new CodexSwarmError(
            'codex_swarm_task_not_found',
            'Codex swarm task not found.',
            404,
          );
        }
        if (TERMINAL_TASK_STATUSES.has(task.status)) {
          if (
            task.status === status
            && task.leaseOwner === workerId
            && task.leaseToken === leaseToken
          ) {
            return {
              task,
              swarm,
              progress: aggregateTaskProgress(await loadTasks(tx, swarmId)),
              replayed: true,
            };
          }
          throw new CodexSwarmError(
            'codex_swarm_task_terminal',
            `Task already finished with status ${task.status}.`,
            409,
          );
        }
        if (
          task.status !== TASK_STATUSES.RUNNING
          || task.leaseOwner !== workerId
          || task.leaseToken !== leaseToken
        ) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task lease is not owned by this worker.',
            409,
          );
        }
        if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
          throw new CodexSwarmError(
            'codex_swarm_lease_expired',
            'The task lease expired before completion.',
            409,
          );
        }

        const finished = await tx.codexSwarmTask.updateMany({
          where: {
            id: task.id,
            swarmId,
            status: TASK_STATUSES.RUNNING,
            leaseOwner: workerId,
            leaseToken,
            leaseExpiresAt: { gt: now },
          },
          data: {
            status,
            ...(result == null ? {} : { result }),
            error: error || null,
            leaseExpiresAt: null,
            lastHeartbeatAt: now,
            finishedAt: now,
            version: { increment: 1 },
          },
        });
        if (finished.count !== 1) {
          throw new CodexSwarmError(
            'codex_swarm_lease_conflict',
            'The task changed concurrently before completion.',
            409,
          );
        }
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        swarm = reconciled.swarm;
        const completedTask = reconciled.tasks.find((candidate) => candidate.id === task.id);
        return {
          task: completedTask,
          swarm,
          progress: reconciled.aggregate,
          replayed: false,
        };
      });
    },

    async cancelSwarm({ swarmId, reason, now }) {
      return withSerializableRetry(prisma, async (tx) => {
        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        if (TERMINAL_SWARM_STATUSES.has(swarm.status)) {
          const tasks = await loadTasks(tx, swarmId);
          return {
            swarm,
            progress: aggregateTaskProgress(tasks),
            replayed: true,
          };
        }
        swarm = await tx.codexSwarm.update({
          where: { id: swarmId },
          data: {
            status: SWARM_STATUSES.CANCELLING,
            cancelRequestedAt: now,
            cancellationReason: reason,
            version: { increment: 1 },
          },
        });
        await tx.codexSwarmTask.updateMany({
          where: {
            swarmId,
            status: {
              in: [
                TASK_STATUSES.QUEUED,
                TASK_STATUSES.BLOCKED,
                TASK_STATUSES.RUNNING,
              ],
            },
          },
          data: {
            status: TASK_STATUSES.CANCELLED,
            error: reason,
            leaseExpiresAt: null,
            lastHeartbeatAt: now,
            finishedAt: now,
            version: { increment: 1 },
          },
        });
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        return {
          swarm: reconciled.swarm,
          progress: reconciled.aggregate,
          replayed: false,
        };
      });
    },

    async pauseSwarm({ swarmId, now }) {
      return withSerializableRetry(prisma, async (tx) => {
        const swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        const tasks = await loadTasks(tx, swarmId);
        if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.status === SWARM_STATUSES.PAUSED) {
          return {
            swarm,
            progress: aggregateTaskProgress(tasks),
            replayed: true,
          };
        }
        const updated = await tx.codexSwarm.update({
          where: { id: swarmId },
          data: {
            status: SWARM_STATUSES.PAUSED,
            version: { increment: 1 },
          },
        });
        return {
          swarm: updated,
          progress: aggregateTaskProgress(tasks),
          replayed: false,
          pausedAt: now,
        };
      });
    },

    async resumeSwarm({ swarmId, now }) {
      return withSerializableRetry(prisma, async (tx) => {
        let swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        const tasks = await loadTasks(tx, swarmId);
        if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.status !== SWARM_STATUSES.PAUSED) {
          return {
            swarm,
            progress: aggregateTaskProgress(tasks),
            replayed: true,
          };
        }
        swarm = await tx.codexSwarm.update({
          where: { id: swarmId },
          data: {
            status: swarm.startedAt ? SWARM_STATUSES.RUNNING : SWARM_STATUSES.QUEUED,
            version: { increment: 1 },
          },
        });
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        return {
          swarm: reconciled.swarm,
          progress: reconciled.aggregate,
          replayed: false,
        };
      });
    },

    async getProgress({ swarmId, now }) {
      return withSerializableRetry(prisma, async (tx) => {
        const swarm = await tx.codexSwarm.findUnique({ where: { id: swarmId } });
        if (!swarm) {
          throw new CodexSwarmError(
            'codex_swarm_not_found',
            'Codex swarm not found.',
            404,
          );
        }
        const reconciled = await reconcileInTransaction(tx, swarm, now);
        return {
          swarm: reconciled.swarm,
          progress: reconciled.aggregate,
          tasks: reconciled.tasks,
        };
      });
    },
  };
}

class CodexSwarmOrchestrator {
  constructor({
    repository = null,
    prisma = null,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}_${crypto.randomUUID()}`,
    tokenFactory = () => crypto.randomBytes(32).toString('base64url'),
  } = {}) {
    this.repository = repository || (prisma ? createPrismaSwarmRepository(prisma) : null);
    if (!this.repository) {
      throw new CodexSwarmError(
        'codex_swarm_repository_required',
        'repository or prisma is required.',
        500,
      );
    }
    for (const method of [
      'createSwarm',
      'appendTasks',
      'claimTask',
      'renewLease',
      'deferTask',
      'finishTask',
      'pauseSwarm',
      'resumeSwarm',
      'cancelSwarm',
      'getProgress',
    ]) {
      if (typeof this.repository[method] !== 'function') {
        throw new CodexSwarmError(
          'codex_swarm_repository_invalid',
          `repository.${method} must be a function.`,
          500,
        );
      }
    }
    if (typeof clock !== 'function' || typeof idFactory !== 'function' || typeof tokenFactory !== 'function') {
      throw new CodexSwarmError(
        'codex_swarm_dependencies_invalid',
        'clock, idFactory and tokenFactory must be functions.',
        500,
      );
    }
    this.clock = clock;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
  }

  now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new CodexSwarmError(
        'codex_swarm_clock_invalid',
        'clock returned an invalid date.',
        500,
      );
    }
    return date;
  }

  async createSwarm({
    userId,
    projectId,
    name,
    strategy = SWARM_STRATEGIES.DAG,
    tasks,
    taskLimit = MAX_LOGICAL_TASKS,
    maxConcurrency = DEFAULT_EFFECTIVE_CONCURRENCY,
    maxConcurrentWriters = null,
    metadata = null,
  } = {}) {
    const normalizedTaskLimit = integerInRange(
      taskLimit,
      MAX_LOGICAL_TASKS,
      1,
      MAX_LOGICAL_TASKS,
      'taskLimit',
    );
    const normalizedConcurrency = integerInRange(
      maxConcurrency,
      DEFAULT_EFFECTIVE_CONCURRENCY,
      1,
      MAX_EFFECTIVE_CONCURRENCY,
      'maxConcurrency',
    );
    const writerFallback = Math.min(DEFAULT_WRITER_CONCURRENCY, normalizedConcurrency);
    const normalizedWriterConcurrency = integerInRange(
      maxConcurrentWriters,
      writerFallback,
      1,
      Math.min(MAX_WRITER_CONCURRENCY, normalizedConcurrency),
      'maxConcurrentWriters',
    );
    const normalizedStrategy = normalizeStrategy(strategy);
    const normalizedTasks = normalizeTasks(tasks, {
      taskLimit: normalizedTaskLimit,
      idFactory: this.idFactory,
    });
    if (normalizedStrategy === SWARM_STRATEGIES.MAP_REDUCE) {
      validateMapReduceShape(normalizedTasks);
    }

    const counts = aggregateTaskProgress(normalizedTasks).counts;
    const swarm = {
      id: requiredString(this.idFactory('swarm'), 'swarm.id', 200),
      userId: requiredString(userId, 'userId', 200),
      projectId: requiredString(projectId, 'projectId', 200),
      name: requiredString(name, 'name', 300),
      strategy: normalizedStrategy,
      status: SWARM_STATUSES.QUEUED,
      taskLimit: normalizedTaskLimit,
      maxConcurrency: normalizedConcurrency,
      maxConcurrentWriters: normalizedWriterConcurrency,
      ...(metadata == null ? {} : { metadata: normalizeJson(metadata, 'metadata') }),
      totalTaskCount: counts.total,
      queuedTaskCount: counts.queued,
      blockedTaskCount: counts.blocked,
      runningTaskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      cancelledTaskCount: 0,
      progressPercent: 0,
      version: 0,
    };
    return this.repository.createSwarm({ swarm, tasks: normalizedTasks });
  }

  async createMapReduceSwarm(params = {}) {
    const tasks = buildMapReduceTaskGraph(params);
    return this.createSwarm({
      ...params,
      strategy: SWARM_STRATEGIES.MAP_REDUCE,
      tasks,
    });
  }

  async appendTasks({
    swarmId,
    tasks,
  } = {}) {
    return this.repository.appendTasks({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      rawTasks: tasks,
      idFactory: this.idFactory,
      now: this.now(),
    });
  }

  async claimNextTask({
    swarmId,
    workerId,
    claimId,
    leaseMs = DEFAULT_LEASE_MS,
    budgetPolicy = null,
  } = {}) {
    const normalizedLeaseMs = integerInRange(
      leaseMs,
      DEFAULT_LEASE_MS,
      MIN_LEASE_MS,
      MAX_LEASE_MS,
      'leaseMs',
    );
    const now = this.now();
    return this.repository.claimTask({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      workerId: requiredString(workerId, 'workerId', 200),
      claimId: requiredString(claimId, 'claimId', 200),
      leaseToken: requiredString(this.tokenFactory(), 'leaseToken', 500),
      now,
      leaseExpiresAt: new Date(now.getTime() + normalizedLeaseMs),
      budgetPolicy: normalizeClaimBudgetPolicy(budgetPolicy),
    });
  }

  async renewTaskLease({
    swarmId,
    taskId,
    workerId,
    leaseToken,
    leaseMs = DEFAULT_LEASE_MS,
  } = {}) {
    const normalizedLeaseMs = integerInRange(
      leaseMs,
      DEFAULT_LEASE_MS,
      MIN_LEASE_MS,
      MAX_LEASE_MS,
      'leaseMs',
    );
    const now = this.now();
    return this.repository.renewLease({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      taskId: requiredString(taskId, 'taskId', 200),
      workerId: requiredString(workerId, 'workerId', 200),
      leaseToken: requiredString(leaseToken, 'leaseToken', 500),
      now,
      leaseExpiresAt: new Date(now.getTime() + normalizedLeaseMs),
    });
  }

  async finishTask({
    swarmId,
    taskId,
    workerId,
    leaseToken,
    status = TASK_STATUSES.SUCCEEDED,
    result = null,
    error = null,
  } = {}) {
    if (![TASK_STATUSES.SUCCEEDED, TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED].includes(status)) {
      throw new CodexSwarmError(
        'codex_swarm_invalid_completion_status',
        'status must be succeeded, failed or cancelled.',
        400,
      );
    }
    const normalizedError = error == null ? null : String(error).slice(0, 20_000);
    return this.repository.finishTask({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      taskId: requiredString(taskId, 'taskId', 200),
      workerId: requiredString(workerId, 'workerId', 200),
      leaseToken: requiredString(leaseToken, 'leaseToken', 500),
      status,
      result: normalizeJson(result, 'result'),
      error: status === TASK_STATUSES.FAILED
        ? (normalizedError || 'task_failed')
        : normalizedError,
      now: this.now(),
    });
  }

  async deferTask({
    swarmId,
    taskId,
    workerId,
    leaseToken,
    reason = 'budget_deferred',
  } = {}) {
    return this.repository.deferTask({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      taskId: requiredString(taskId, 'taskId', 200),
      workerId: requiredString(workerId, 'workerId', 200),
      leaseToken: requiredString(leaseToken, 'leaseToken', 500),
      reason: requiredString(reason, 'reason', 20_000),
      now: this.now(),
    });
  }

  async cancelSwarm({ swarmId, reason = 'cancelled_by_user' } = {}) {
    return this.repository.cancelSwarm({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      reason: requiredString(reason, 'reason', 20_000),
      now: this.now(),
    });
  }

  async pauseSwarm({ swarmId } = {}) {
    return this.repository.pauseSwarm({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      now: this.now(),
    });
  }

  async resumeSwarm({ swarmId } = {}) {
    return this.repository.resumeSwarm({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      now: this.now(),
    });
  }

  async getProgress(swarmId) {
    return this.repository.getProgress({
      swarmId: requiredString(swarmId, 'swarmId', 200),
      now: this.now(),
    });
  }
}

module.exports = {
  MAX_LOGICAL_TASKS,
  DEFAULT_EFFECTIVE_CONCURRENCY,
  MAX_EFFECTIVE_CONCURRENCY,
  DEFAULT_WRITER_CONCURRENCY,
  MAX_WRITER_CONCURRENCY,
  DEFAULT_LEASE_MS,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  SWARM_STRATEGIES,
  SWARM_STATUSES,
  ACTIVE_SWARM_STATUSES,
  TASK_STATUSES,
  TASK_ROLES,
  TASK_STAGES,
  TERMINAL_SWARM_STATUSES,
  TERMINAL_TASK_STATUSES,
  WRITE_ROLES,
  CodexSwarmError,
  CodexSwarmOrchestrator,
  normalizeTasks,
  normalizeAdditionalTasks,
  validateTaskGraph,
  validateMapReduceShape,
  buildMapReduceTaskGraph,
  aggregateTaskProgress,
  deriveSwarmStatus,
  createPrismaSwarmRepository,
};
