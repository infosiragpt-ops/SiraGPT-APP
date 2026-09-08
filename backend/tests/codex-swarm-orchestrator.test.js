'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_LOGICAL_TASKS,
  MAX_EFFECTIVE_CONCURRENCY,
  MAX_WRITER_CONCURRENCY,
  SWARM_STRATEGIES,
  SWARM_STATUSES,
  TASK_STATUSES,
  TASK_ROLES,
  TASK_STAGES,
  TERMINAL_SWARM_STATUSES,
  TERMINAL_TASK_STATUSES,
  WRITE_ROLES,
  CodexSwarmError,
  CodexSwarmOrchestrator,
  buildMapReduceTaskGraph,
  aggregateTaskProgress,
  deriveSwarmStatus,
  createPrismaSwarmRepository,
  normalizeAdditionalTasks,
} = require('../src/services/codex/swarm-orchestrator');
const { taskBudgetReservationUsd } = require('../src/services/codex/project-budget');

function copy(value) {
  return structuredClone(value);
}

function createMemoryRepository() {
  const swarms = new Map();
  const tasksBySwarm = new Map();

  function tasksFor(swarmId) {
    return tasksBySwarm.get(swarmId) || [];
  }

  function refresh(swarmId, now) {
    const swarm = swarms.get(swarmId);
    const tasks = tasksFor(swarmId);
    const progress = aggregateTaskProgress(tasks);
    const status = deriveSwarmStatus(swarm, progress);
    Object.assign(swarm, {
      status,
      totalTaskCount: progress.counts.total,
      queuedTaskCount: progress.counts.queued,
      blockedTaskCount: progress.counts.blocked,
      runningTaskCount: progress.counts.running,
      succeededTaskCount: progress.counts.succeeded,
      failedTaskCount: progress.counts.failed,
      cancelledTaskCount: progress.counts.cancelled,
      progressPercent: progress.progressPercent,
      startedAt: status === SWARM_STATUSES.RUNNING
        ? (swarm.startedAt || new Date(now))
        : swarm.startedAt,
      finishedAt: TERMINAL_SWARM_STATUSES.has(status)
        ? (swarm.finishedAt || new Date(now))
        : swarm.finishedAt,
      version: swarm.version + 1,
    });
    return progress;
  }

  function reconcileDependencies(swarmId, now) {
    const tasks = tasksFor(swarmId);
    let changed = true;
    while (changed) {
      changed = false;
      const statuses = new Map(tasks.map((task) => [task.key, task.status]));
      for (const task of tasks) {
        if (TERMINAL_TASK_STATUSES.has(task.status) || task.status === TASK_STATUSES.RUNNING) {
          continue;
        }
        const tolerantReducer = (
          task.role === TASK_ROLES.REVIEWER
          && task.stage === TASK_STAGES.REDUCE
        );
        const failedDependency = tolerantReducer ? null : task.dependsOn.find((dependency) => (
          [TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED].includes(statuses.get(dependency))
        ));
        const ready = task.dependsOn.every((dependency) => {
          const status = statuses.get(dependency);
          return tolerantReducer
            ? TERMINAL_TASK_STATUSES.has(status)
            : status === TASK_STATUSES.SUCCEEDED;
        });
        const nextStatus = failedDependency
          ? TASK_STATUSES.CANCELLED
          : (ready ? TASK_STATUSES.QUEUED : TASK_STATUSES.BLOCKED);
        if (task.status === nextStatus) continue;
        task.status = nextStatus;
        task.error = failedDependency ? `dependency_failed:${failedDependency}` : null;
        task.finishedAt = failedDependency ? new Date(now) : null;
        task.version += 1;
        changed = true;
      }
    }
  }

  function reconcileExpired(swarmId, now) {
    for (const task of tasksFor(swarmId)) {
      if (
        task.status !== TASK_STATUSES.RUNNING
        || !task.leaseExpiresAt
        || task.leaseExpiresAt.getTime() > now.getTime()
      ) {
        continue;
      }
      const exhausted = task.attemptCount >= task.maxAttempts;
      task.status = exhausted ? TASK_STATUSES.FAILED : TASK_STATUSES.QUEUED;
      task.claimId = null;
      task.leaseOwner = null;
      task.leaseToken = null;
      task.leaseExpiresAt = null;
      task.error = exhausted ? 'lease_expired_max_attempts' : null;
      task.finishedAt = exhausted ? new Date(now) : null;
      task.version += 1;
    }
    reconcileDependencies(swarmId, now);
    return refresh(swarmId, now);
  }

  return {
    state: { swarms, tasksBySwarm },

    async createSwarm({ swarm, tasks }) {
      swarms.set(swarm.id, copy(swarm));
      tasksBySwarm.set(
        swarm.id,
        copy(tasks.map((task) => ({
          ...task,
          swarmId: swarm.id,
          result: null,
          error: null,
          claimId: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          claimedAt: null,
          lastHeartbeatAt: null,
          startedAt: null,
          finishedAt: null,
        }))),
      );
      return copy({ ...swarms.get(swarm.id), tasks: tasksFor(swarm.id) });
    },

    async appendTasks({
      swarmId,
      rawTasks,
      idFactory,
      now,
    }) {
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.cancelRequestedAt) {
        throw new CodexSwarmError('codex_swarm_terminal', 'terminal', 409);
      }
      const normalized = normalizeAdditionalTasks(rawTasks, {
        existingTasks: tasksFor(swarmId),
        taskLimit: swarm.taskLimit,
        idFactory,
      });
      tasksFor(swarmId).push(...copy(normalized.tasks.map((task) => ({
        ...task,
        swarmId,
        result: null,
        error: null,
        claimId: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        claimedAt: null,
        lastHeartbeatAt: null,
        startedAt: null,
        finishedAt: null,
      }))));
      reconcileDependencies(swarmId, now);
      const progress = refresh(swarmId, now);
      return {
        swarm: copy(swarm),
        tasks: copy(tasksFor(swarmId)),
        progress: copy(progress),
        appended: copy(normalized.tasks),
        replayed: normalized.replayed,
      };
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
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      const existingBeforeReconcile = Array.from(tasksBySwarm.values())
        .flat()
        .find((task) => task.claimId === claimId);
      if (
        existingBeforeReconcile
        && (
          existingBeforeReconcile.swarmId !== swarmId
          || existingBeforeReconcile.leaseOwner !== workerId
        )
      ) {
        throw new CodexSwarmError('codex_swarm_claim_id_conflict', 'conflict', 409);
      }

      reconcileExpired(swarmId, now);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.cancelRequestedAt) {
        return { task: null, replayed: false, reason: 'swarm_terminal' };
      }
      if (swarm.status === SWARM_STATUSES.PAUSED) {
        return { task: null, replayed: false, reason: 'swarm_paused' };
      }
      const tasks = tasksFor(swarmId);
      const running = tasks.filter((task) => task.status === TASK_STATUSES.RUNNING);
      if (existingBeforeReconcile) {
        const existing = tasks.find((task) => task.id === existingBeforeReconcile.id);
        if (
          !existing
          || existing.status !== TASK_STATUSES.RUNNING
          || existing.leaseOwner !== workerId
          || existing.leaseToken !== existingBeforeReconcile.leaseToken
          || !existing.leaseExpiresAt
          || existing.leaseExpiresAt.getTime() <= now.getTime()
        ) {
          throw new CodexSwarmError('codex_swarm_claim_expired', 'expired', 409);
        }
        if (budgetPolicy) {
          const activeReservationsUsd = running.reduce(
            (total, row) => total + taskBudgetReservationUsd(
              row,
              budgetPolicy.defaultReservationUsd,
            ),
            0,
          );
          const projectBlocked = budgetPolicy.projectDailyBudgetUsd != null
            && activeReservationsUsd > budgetPolicy.projectDailyBudgetUsd;
          const companyBlocked = budgetPolicy.companyDailyBudgetUsd != null
            && activeReservationsUsd > budgetPolicy.companyDailyBudgetUsd;
          if (projectBlocked || companyBlocked) {
            swarm.status = SWARM_STATUSES.PAUSED;
            swarm.version += 1;
            Object.assign(existing, {
              status: TASK_STATUSES.QUEUED,
              claimId: null,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              claimedAt: null,
              error: `claim_replay_deferred:${
                projectBlocked ? 'project_budget_limit' : 'company_budget_limit'
              }`,
              attemptCount: Math.max(0, existing.attemptCount - 1),
              version: existing.version + 1,
            });
            refresh(swarmId, now);
            return {
              task: null,
              replayed: false,
              reason: projectBlocked ? 'project_budget_limit' : 'company_budget_limit',
            };
          }
        }
        return { task: copy(existing), replayed: true, reason: null };
      }
      if (running.length >= swarm.maxConcurrency) {
        return { task: null, replayed: false, reason: 'concurrency_limit' };
      }
      const runningWriters = running.filter((task) => WRITE_ROLES.has(task.role)).length;
      const candidates = tasks
        .filter((task) => task.status === TASK_STATUSES.QUEUED)
        .sort((left, right) => right.priority - left.priority || left.ordinal - right.ordinal);
      const task = candidates.find((candidate) => (
        !WRITE_ROLES.has(candidate.role) || runningWriters < swarm.maxConcurrentWriters
      ));
      if (!task) {
        return {
          task: null,
          replayed: false,
          reason: candidates.some((candidate) => WRITE_ROLES.has(candidate.role))
            ? 'writer_concurrency_limit'
            : 'no_ready_tasks',
        };
      }
      if (budgetPolicy) {
        const activeReservationsUsd = running.reduce(
          (total, row) => total + taskBudgetReservationUsd(
            row,
            budgetPolicy.defaultReservationUsd,
          ),
          0,
        );
        const projectedCostUsd = activeReservationsUsd + taskBudgetReservationUsd(
          task,
          budgetPolicy.defaultReservationUsd,
        );
        const projectBlocked = budgetPolicy.projectDailyBudgetUsd != null
          && projectedCostUsd > budgetPolicy.projectDailyBudgetUsd;
        const companyBlocked = budgetPolicy.companyDailyBudgetUsd != null
          && projectedCostUsd > budgetPolicy.companyDailyBudgetUsd;
        if (projectBlocked || companyBlocked) {
          swarm.status = SWARM_STATUSES.PAUSED;
          swarm.version += 1;
          refresh(swarmId, now);
          return {
            task: null,
            replayed: false,
            reason: projectBlocked ? 'project_budget_limit' : 'company_budget_limit',
          };
        }
      }
      Object.assign(task, {
        status: TASK_STATUSES.RUNNING,
        claimId,
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt: new Date(leaseExpiresAt),
        claimedAt: new Date(now),
        lastHeartbeatAt: new Date(now),
        startedAt: task.startedAt || new Date(now),
        attemptCount: task.attemptCount + 1,
        version: task.version + 1,
      });
      refresh(swarmId, now);
      return { task: copy(task), replayed: false, reason: null };
    },

    async renewLease({
      swarmId,
      taskId,
      workerId,
      leaseToken,
      now,
      leaseExpiresAt,
    }) {
      const task = tasksFor(swarmId).find((candidate) => candidate.id === taskId);
      if (
        !task
        || task.status !== TASK_STATUSES.RUNNING
        || task.leaseOwner !== workerId
        || task.leaseToken !== leaseToken
      ) {
        throw new CodexSwarmError('codex_swarm_lease_conflict', 'conflict', 409);
      }
      if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new CodexSwarmError('codex_swarm_lease_expired', 'expired', 409);
      }
      task.leaseExpiresAt = new Date(leaseExpiresAt);
      task.lastHeartbeatAt = new Date(now);
      task.version += 1;
      return copy(task);
    },

    async deferTask({
      swarmId,
      taskId,
      workerId,
      leaseToken,
      reason,
      now,
    }) {
      const swarm = swarms.get(swarmId);
      const task = tasksFor(swarmId).find((candidate) => candidate.id === taskId);
      if (!task) throw new CodexSwarmError('codex_swarm_task_not_found', 'not found', 404);
      if (
        task.status !== TASK_STATUSES.RUNNING
        || task.leaseOwner !== workerId
        || task.leaseToken !== leaseToken
      ) {
        throw new CodexSwarmError('codex_swarm_lease_conflict', 'conflict', 409);
      }
      if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new CodexSwarmError('codex_swarm_lease_expired', 'expired', 409);
      }
      swarm.status = SWARM_STATUSES.PAUSED;
      swarm.version += 1;
      Object.assign(task, {
        status: TASK_STATUSES.QUEUED,
        claimId: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        claimedAt: null,
        lastHeartbeatAt: new Date(now),
        error: reason,
        finishedAt: null,
        attemptCount: Math.max(0, task.attemptCount - 1),
        version: task.version + 1,
      });
      const progress = refresh(swarmId, now);
      return {
        task: copy(task),
        swarm: copy(swarm),
        progress: copy(progress),
        replayed: false,
      };
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
      const swarm = swarms.get(swarmId);
      const task = tasksFor(swarmId).find((candidate) => candidate.id === taskId);
      if (!task) throw new CodexSwarmError('codex_swarm_task_not_found', 'not found', 404);
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        if (
          task.status === status
          && task.leaseOwner === workerId
          && task.leaseToken === leaseToken
        ) {
          return {
            task: copy(task),
            swarm: copy(swarm),
            progress: copy(aggregateTaskProgress(tasksFor(swarmId))),
            replayed: true,
          };
        }
        throw new CodexSwarmError('codex_swarm_task_terminal', 'terminal', 409);
      }
      if (
        task.status !== TASK_STATUSES.RUNNING
        || task.leaseOwner !== workerId
        || task.leaseToken !== leaseToken
      ) {
        throw new CodexSwarmError('codex_swarm_lease_conflict', 'conflict', 409);
      }
      if (!task.leaseExpiresAt || task.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new CodexSwarmError('codex_swarm_lease_expired', 'expired', 409);
      }
      Object.assign(task, {
        status,
        result,
        error,
        leaseExpiresAt: null,
        lastHeartbeatAt: new Date(now),
        finishedAt: new Date(now),
        version: task.version + 1,
      });
      reconcileDependencies(swarmId, now);
      const progress = refresh(swarmId, now);
      return {
        task: copy(task),
        swarm: copy(swarm),
        progress: copy(progress),
        replayed: false,
      };
    },

    async cancelSwarm({ swarmId, reason, now }) {
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status)) {
        return {
          swarm: copy(swarm),
          progress: copy(aggregateTaskProgress(tasksFor(swarmId))),
          replayed: true,
        };
      }
      swarm.status = SWARM_STATUSES.CANCELLING;
      swarm.cancelRequestedAt = new Date(now);
      swarm.cancellationReason = reason;
      for (const task of tasksFor(swarmId)) {
        if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
        task.status = TASK_STATUSES.CANCELLED;
        task.error = reason;
        task.leaseExpiresAt = null;
        task.lastHeartbeatAt = new Date(now);
        task.finishedAt = new Date(now);
        task.version += 1;
      }
      const progress = refresh(swarmId, now);
      return { swarm: copy(swarm), progress: copy(progress), replayed: false };
    },

    async pauseSwarm({ swarmId, now }) {
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.status === SWARM_STATUSES.PAUSED) {
        return {
          swarm: copy(swarm),
          progress: copy(aggregateTaskProgress(tasksFor(swarmId))),
          replayed: true,
        };
      }
      swarm.status = SWARM_STATUSES.PAUSED;
      swarm.version += 1;
      return {
        swarm: copy(swarm),
        progress: copy(aggregateTaskProgress(tasksFor(swarmId))),
        replayed: false,
        pausedAt: new Date(now),
      };
    },

    async resumeSwarm({ swarmId, now }) {
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status) || swarm.status !== SWARM_STATUSES.PAUSED) {
        return {
          swarm: copy(swarm),
          progress: copy(aggregateTaskProgress(tasksFor(swarmId))),
          replayed: true,
        };
      }
      swarm.status = swarm.startedAt ? SWARM_STATUSES.RUNNING : SWARM_STATUSES.QUEUED;
      swarm.version += 1;
      const progress = refresh(swarmId, now);
      return { swarm: copy(swarm), progress: copy(progress), replayed: false };
    },

    async getProgress({ swarmId, now }) {
      const swarm = swarms.get(swarmId);
      if (!swarm) throw new CodexSwarmError('codex_swarm_not_found', 'not found', 404);
      const progress = reconcileExpired(swarmId, now);
      return {
        swarm: copy(swarm),
        progress: copy(progress),
        tasks: copy(tasksFor(swarmId)),
      };
    },
  };
}

function createHarness() {
  const repository = createMemoryRepository();
  let currentTime = new Date('2026-07-27T12:00:00.000Z');
  let idSequence = 0;
  let tokenSequence = 0;
  const orchestrator = new CodexSwarmOrchestrator({
    repository,
    clock: () => new Date(currentTime),
    idFactory: (kind) => `${kind}-${++idSequence}`,
    tokenFactory: () => `lease-token-${++tokenSequence}`,
  });
  return {
    orchestrator,
    repository,
    advance(ms) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

async function createBasicSwarm(orchestrator, overrides = {}) {
  return orchestrator.createSwarm({
    userId: 'user-1',
    projectId: 'project-1',
    name: 'Production refactor',
    tasks: [{ key: 'task-a', title: 'Task A', role: TASK_ROLES.WRITER }],
    ...overrides,
  });
}

test('schema and additive migration define durable CodexSwarm relations and constraints', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '../prisma/schema.prisma'),
    'utf8',
  );
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      '../prisma/migrations/20260727120000_add_codex_swarms/migration.sql',
    ),
    'utf8',
  );
  const scaleMigration = fs.readFileSync(
    path.join(
      __dirname,
      '../prisma/migrations/20260730210000_raise_codex_swarm_logical_capacity_10k/migration.sql',
    ),
    'utf8',
  );
  assert.match(schema, /model CodexSwarm \{/);
  assert.match(schema, /model CodexSwarmTask \{/);
  assert.match(schema, /codexSwarms\s+CodexSwarm\[\]/);
  assert.match(schema, /swarms\s+CodexSwarm\[\]/);
  assert.match(schema, /taskLimit\s+Int\s+@default\(10000\)/);
  // Original bootstrap constraints (historical).
  assert.match(migration, /CHECK \("ordinal" BETWEEN 0 AND 999\)/);
  assert.match(migration, /"maxConcurrency" BETWEEN 1 AND 128/);
  assert.match(migration, /"maxConcurrentWriters" BETWEEN 1 AND 32/);
  assert.match(migration, /codex_swarms_project_active_key/);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE FROM)\b/i);
  // Scale-up migration: 10k logical agents + 256 research concurrency.
  assert.match(scaleMigration, /BETWEEN 1 AND 10000/);
  assert.match(scaleMigration, /BETWEEN 1 AND 256/);
  assert.match(scaleMigration, /BETWEEN 0 AND 9999/);
});

test('creates exactly MAX_LOGICAL_TASKS (10k) with durable initial counters', async () => {
  const { orchestrator } = createHarness();
  const tasks = Array.from({ length: MAX_LOGICAL_TASKS }, (_, index) => ({
    key: `task-${index}`,
    title: `Logical task ${index}`,
    role: TASK_ROLES.READ_ONLY,
  }));
  const swarm = await createBasicSwarm(orchestrator, { tasks });
  assert.equal(MAX_LOGICAL_TASKS, 10_000);
  assert.equal(swarm.tasks.length, MAX_LOGICAL_TASKS);
  assert.equal(swarm.totalTaskCount, MAX_LOGICAL_TASKS);
  assert.equal(swarm.queuedTaskCount, MAX_LOGICAL_TASKS);
  assert.equal(swarm.blockedTaskCount, 0);
  assert.equal(swarm.maxConcurrency, 64);
  assert.equal(swarm.maxConcurrentWriters, 4);
});

test('appends idempotent remediation tasks to a running DAG and unlocks dependencies', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  const parent = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'writer-1',
    claimId: 'claim-parent',
  });

  const appended = await orchestrator.appendTasks({
    swarmId: swarm.id,
    tasks: [{
      key: 'qa-fix-auth',
      title: 'Corrige autorización rota',
      role: TASK_ROLES.INTEGRATOR,
      dependsOn: ['task-a'],
      priority: 90,
      input: { source: 'fleet_qa', severity: 'high' },
    }],
  });
  assert.equal(appended.appended.length, 1);
  assert.equal(appended.progress.counts.total, 2);
  assert.equal(
    appended.tasks.find((task) => task.key === 'qa-fix-auth').status,
    TASK_STATUSES.BLOCKED,
  );

  const replay = await orchestrator.appendTasks({
    swarmId: swarm.id,
    tasks: [{
      key: 'qa-fix-auth',
      title: 'Corrige autorización rota',
      role: TASK_ROLES.INTEGRATOR,
      dependsOn: ['task-a'],
    }],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.progress.counts.total, 2);

  await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: parent.task.id,
    workerId: 'writer-1',
    leaseToken: parent.task.leaseToken,
    status: TASK_STATUSES.SUCCEEDED,
  });
  const ready = await orchestrator.getProgress(swarm.id);
  assert.equal(
    ready.tasks.find((task) => task.key === 'qa-fix-auth').status,
    TASK_STATUSES.QUEUED,
  );
});

test('rejects appended tasks that would reference a missing DAG dependency', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  await assert.rejects(
    orchestrator.appendTasks({
      swarmId: swarm.id,
      tasks: [{
        key: 'qa-invalid',
        title: 'Invalid remediation',
        role: TASK_ROLES.INTEGRATOR,
        dependsOn: ['missing-task'],
      }],
    }),
    (error) => error instanceof CodexSwarmError
      && error.code === 'codex_swarm_missing_dependency',
  );
  const progress = await orchestrator.getProgress(swarm.id);
  assert.equal(progress.progress.counts.total, 1);
});

test('rejects more than MAX_LOGICAL_TASKS before persistence', async () => {
  const { orchestrator, repository } = createHarness();
  const tasks = Array.from({ length: MAX_LOGICAL_TASKS + 1 }, (_, index) => ({
    key: `task-${index}`,
  }));
  await assert.rejects(
    createBasicSwarm(orchestrator, { tasks }),
    (error) => error.code === 'codex_swarm_task_limit' && error.status === 413,
  );
  assert.equal(repository.state.swarms.size, 0);
});

test('rejects duplicate, missing, self and cyclic dependencies', async () => {
  const cases = [
    {
      code: 'codex_swarm_duplicate_task_key',
      tasks: [{ key: 'a' }, { key: 'a' }],
    },
    {
      code: 'codex_swarm_missing_dependency',
      tasks: [{ key: 'a', dependsOn: ['missing'] }],
    },
    {
      code: 'codex_swarm_self_dependency',
      tasks: [{ key: 'a', dependsOn: ['a'] }],
    },
    {
      code: 'codex_swarm_dependency_cycle',
      tasks: [
        { key: 'a', dependsOn: ['c'] },
        { key: 'b', dependsOn: ['a'] },
        { key: 'c', dependsOn: ['b'] },
      ],
    },
  ];
  for (const entry of cases) {
    const { orchestrator } = createHarness();
    await assert.rejects(
      createBasicSwarm(orchestrator, { tasks: entry.tasks }),
      (error) => error.code === entry.code,
    );
  }
});

test('normalizes read_only and rejects unsupported roles', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [{ key: 'reader', role: 'read_only' }],
  });
  assert.equal(swarm.tasks[0].role, TASK_ROLES.READ_ONLY);
  await assert.rejects(
    createBasicSwarm(orchestrator, {
      tasks: [{ key: 'owner', role: 'super-writer' }],
    }),
    (error) => error.code === 'codex_swarm_invalid_role',
  );
});

test('enforces bounded effective and writer concurrency configuration', async () => {
  const { orchestrator } = createHarness();
  await assert.rejects(
    createBasicSwarm(orchestrator, {
      maxConcurrency: MAX_EFFECTIVE_CONCURRENCY + 1,
    }),
    (error) => error.code === 'codex_swarm_invalid_limit',
  );
  await assert.rejects(
    createBasicSwarm(orchestrator, {
      maxConcurrency: 4,
      maxConcurrentWriters: 5,
    }),
    (error) => error.code === 'codex_swarm_invalid_limit',
  );
  await assert.rejects(
    createBasicSwarm(orchestrator, {
      maxConcurrency: 64,
      maxConcurrentWriters: MAX_WRITER_CONCURRENCY + 1,
    }),
    (error) => error.code === 'codex_swarm_invalid_limit',
  );
});

test('builds a map-reduce DAG with reviewer reduction and one final integrator', () => {
  const graph = buildMapReduceTaskGraph({
    maps: [{ key: 'api' }, { key: 'frontend', role: TASK_ROLES.READ_ONLY }],
  });
  assert.deepEqual(
    graph.map(({ key, stage, role, dependsOn }) => ({ key, stage, role, dependsOn })),
    [
      {
        key: 'api',
        stage: TASK_STAGES.MAP,
        role: TASK_ROLES.WRITER,
        dependsOn: [],
      },
      {
        key: 'frontend',
        stage: TASK_STAGES.MAP,
        role: TASK_ROLES.READ_ONLY,
        dependsOn: [],
      },
      {
        key: 'reduce',
        stage: TASK_STAGES.REDUCE,
        role: TASK_ROLES.REVIEWER,
        dependsOn: ['api', 'frontend'],
      },
      {
        key: 'integrate',
        stage: TASK_STAGES.INTEGRATE,
        role: TASK_ROLES.INTEGRATOR,
        dependsOn: ['reduce'],
      },
    ],
  );
});

test('createMapReduceSwarm persists strategy and keeps dependent phases blocked', async () => {
  const { orchestrator } = createHarness();
  const swarm = await orchestrator.createMapReduceSwarm({
    userId: 'user-1',
    projectId: 'project-1',
    name: 'Map reduce implementation',
    maps: [{ key: 'slice-a' }, { key: 'slice-b' }],
    maxConcurrency: 8,
    maxConcurrentWriters: 2,
  });
  assert.equal(swarm.strategy, SWARM_STRATEGIES.MAP_REDUCE);
  assert.equal(swarm.queuedTaskCount, 2);
  assert.equal(swarm.blockedTaskCount, 2);
  assert.equal(swarm.tasks.at(-1).role, TASK_ROLES.INTEGRATOR);
});

test('claim is idempotent for the same worker and claimId', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  const first = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  const replay = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.task.leaseToken, first.task.leaseToken);
  assert.equal(replay.task.attemptCount, 1);
});

test('an expired claim replay reconciles the lease before it can return a task', async () => {
  const { orchestrator, advance } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-expired',
    leaseMs: 5_000,
  });
  advance(6_000);
  await assert.rejects(
    orchestrator.claimNextTask({
      swarmId: swarm.id,
      workerId: 'worker-1',
      claimId: 'claim-expired',
      budgetPolicy: {
        projectDailyBudgetUsd: 0,
        companyDailyBudgetUsd: 0,
        defaultReservationUsd: 0.25,
      },
    }),
    (error) => error.code === 'codex_swarm_claim_expired',
  );
  const progress = await orchestrator.getProgress(swarm.id);
  assert.equal(progress.tasks[0].status, TASK_STATUSES.QUEUED);
  assert.equal(progress.tasks[0].leaseToken, null);
});

test('an active replay rechecks a lowered budget and releases its lease', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-lowered-budget',
    budgetPolicy: {
      projectDailyBudgetUsd: 0.25,
      companyDailyBudgetUsd: 1,
      defaultReservationUsd: 0.25,
    },
  });
  const replay = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-lowered-budget',
    budgetPolicy: {
      projectDailyBudgetUsd: 0,
      companyDailyBudgetUsd: 0,
      defaultReservationUsd: 0.25,
    },
  });
  const progress = await orchestrator.getProgress(swarm.id);
  assert.equal(replay.task, null);
  assert.equal(replay.reason, 'project_budget_limit');
  assert.equal(progress.swarm.status, SWARM_STATUSES.PAUSED);
  assert.equal(progress.tasks[0].status, TASK_STATUSES.QUEUED);
  assert.equal(progress.tasks[0].attemptCount, 0);
});

test('claimId cannot be replayed by another worker', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  await assert.rejects(
    orchestrator.claimNextTask({
      swarmId: swarm.id,
      workerId: 'worker-2',
      claimId: 'claim-1',
    }),
    (error) => error.code === 'codex_swarm_claim_id_conflict',
  );
});

test('effective concurrency is enforced even when more logical tasks are ready', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    maxConcurrency: 2,
    maxConcurrentWriters: 2,
    tasks: [
      { key: 'a', role: TASK_ROLES.READ_ONLY },
      { key: 'b', role: TASK_ROLES.READ_ONLY },
      { key: 'c', role: TASK_ROLES.READ_ONLY },
    ],
  });
  assert.ok((await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  })).task);
  assert.ok((await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-2',
  })).task);
  const blocked = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-3',
    claimId: 'claim-3',
  });
  assert.equal(blocked.task, null);
  assert.equal(blocked.reason, 'concurrency_limit');
});

test('writer cap does not prevent an independent reviewer from running', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    maxConcurrency: 3,
    maxConcurrentWriters: 1,
    tasks: [
      { key: 'writer-a', role: TASK_ROLES.WRITER, priority: 100 },
      { key: 'writer-b', role: TASK_ROLES.WRITER, priority: 90 },
      { key: 'reviewer', role: TASK_ROLES.REVIEWER, priority: 10 },
    ],
  });
  const writer = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  const reviewer = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-2',
  });
  const writerBlocked = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-3',
    claimId: 'claim-3',
  });
  assert.equal(writer.task.role, TASK_ROLES.WRITER);
  assert.equal(reviewer.task.role, TASK_ROLES.REVIEWER);
  assert.equal(writerBlocked.reason, 'writer_concurrency_limit');
});

test('successful completion unlocks dependent DAG tasks and is idempotent', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'write', role: TASK_ROLES.WRITER },
      { key: 'review', role: TASK_ROLES.REVIEWER, dependsOn: ['write'] },
    ],
  });
  const claim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-write',
  });
  const completed = await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: claim.task.id,
    workerId: 'worker-1',
    leaseToken: claim.task.leaseToken,
    status: TASK_STATUSES.SUCCEEDED,
    result: { patch: 'abc123' },
  });
  const replay = await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: claim.task.id,
    workerId: 'worker-1',
    leaseToken: claim.task.leaseToken,
    status: TASK_STATUSES.SUCCEEDED,
    result: { patch: 'abc123' },
  });
  const reviewClaim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-review',
  });
  assert.equal(completed.progress.counts.succeeded, 1);
  assert.equal(replay.replayed, true);
  assert.equal(reviewClaim.task.key, 'review');
});

test('failed dependency cancellation propagates transitively and closes the swarm', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'write', role: TASK_ROLES.WRITER },
      { key: 'review', role: TASK_ROLES.REVIEWER, dependsOn: ['write'] },
      { key: 'integrate', role: TASK_ROLES.INTEGRATOR, dependsOn: ['review'] },
    ],
  });
  const claim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-write',
  });
  const failed = await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: claim.task.id,
    workerId: 'worker-1',
    leaseToken: claim.task.leaseToken,
    status: TASK_STATUSES.FAILED,
    error: 'tests failed',
  });
  const progress = await orchestrator.getProgress(swarm.id);
  assert.equal(failed.progress.counts.failed, 1);
  assert.equal(progress.progress.counts.cancelled, 2);
  assert.equal(progress.progress.progressPercent, 100);
  assert.equal(progress.swarm.status, SWARM_STATUSES.FAILED);
  assert.match(
    progress.tasks.find((task) => task.key === 'review').error,
    /^dependency_failed:/,
  );
});

test('a reduce reviewer can synthesize partial map results after one shard fails', async () => {
  const { orchestrator } = createHarness();
  const swarm = await orchestrator.createMapReduceSwarm({
    userId: 'user-1',
    projectId: 'project-1',
    name: 'Resilient enterprise audit',
    maps: [
      { key: 'map-a', title: 'Map A', role: TASK_ROLES.READ_ONLY },
      { key: 'map-b', title: 'Map B', role: TASK_ROLES.READ_ONLY },
    ],
    reducers: [{ key: 'reduce', title: 'Reduce findings' }],
    integrator: { key: 'integrate', title: 'Integrate' },
  });
  const first = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-a',
    claimId: 'claim-a',
  });
  const second = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-b',
    claimId: 'claim-b',
  });
  await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: first.task.id,
    workerId: 'worker-a',
    leaseToken: first.task.leaseToken,
    status: TASK_STATUSES.SUCCEEDED,
    result: { summary: 'usable evidence' },
  });
  await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: second.task.id,
    workerId: 'worker-b',
    leaseToken: second.task.leaseToken,
    status: TASK_STATUSES.FAILED,
    error: 'provider timeout',
  });
  const reduce = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'reviewer',
    claimId: 'claim-reduce',
  });
  assert.equal(reduce.task.key, 'reduce');
  assert.equal(reduce.task.role, TASK_ROLES.REVIEWER);
});

test('lease renewal extends ownership and rejects stale tokens', async () => {
  const { orchestrator, advance } = createHarness();
  const swarm = await createBasicSwarm(orchestrator);
  const claim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
    leaseMs: 5_000,
  });
  advance(4_000);
  const renewed = await orchestrator.renewTaskLease({
    swarmId: swarm.id,
    taskId: claim.task.id,
    workerId: 'worker-1',
    leaseToken: claim.task.leaseToken,
    leaseMs: 10_000,
  });
  assert.equal(
    renewed.leaseExpiresAt.toISOString(),
    '2026-07-27T12:00:14.000Z',
  );
  await assert.rejects(
    orchestrator.renewTaskLease({
      swarmId: swarm.id,
      taskId: claim.task.id,
      workerId: 'worker-1',
      leaseToken: 'stale-token',
    }),
    (error) => error.code === 'codex_swarm_lease_conflict',
  );
});

test('expired leases are reclaimed until maxAttempts then fail durably', async () => {
  const { orchestrator, advance } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [{
      key: 'fragile',
      role: TASK_ROLES.WRITER,
      maxAttempts: 2,
    }],
  });
  const first = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
    leaseMs: 5_000,
  });
  assert.equal(first.task.attemptCount, 1);
  advance(6_000);
  const second = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-2',
    leaseMs: 5_000,
  });
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.attemptCount, 2);
  advance(6_000);
  const progress = await orchestrator.getProgress(swarm.id);
  assert.equal(progress.tasks[0].status, TASK_STATUSES.FAILED);
  assert.equal(progress.tasks[0].error, 'lease_expired_max_attempts');
  assert.equal(progress.swarm.status, SWARM_STATUSES.FAILED);
});

test('cancellation is durable, cancels running and blocked work, and is idempotent', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'write', role: TASK_ROLES.WRITER },
      { key: 'review', role: TASK_ROLES.REVIEWER, dependsOn: ['write'] },
    ],
  });
  await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  const cancelled = await orchestrator.cancelSwarm({
    swarmId: swarm.id,
    reason: 'user_stopped_swarm',
  });
  const replay = await orchestrator.cancelSwarm({
    swarmId: swarm.id,
    reason: 'user_stopped_swarm',
  });
  assert.equal(cancelled.swarm.status, SWARM_STATUSES.CANCELLED);
  assert.equal(cancelled.progress.counts.cancelled, 2);
  assert.equal(cancelled.progress.progressPercent, 100);
  assert.equal(replay.replayed, true);
});

test('pause blocks new claims and resume continues the same durable swarm', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'audit-a', role: TASK_ROLES.READ_ONLY },
      { key: 'audit-b', role: TASK_ROLES.READ_ONLY },
    ],
    maxConcurrency: 2,
  });
  const first = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-1',
  });
  const paused = await orchestrator.pauseSwarm({ swarmId: swarm.id });
  const blockedClaim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-2',
  });

  assert.equal(paused.swarm.status, SWARM_STATUSES.PAUSED);
  assert.equal(blockedClaim.task, null);
  assert.equal(blockedClaim.reason, 'swarm_paused');

  await orchestrator.finishTask({
    swarmId: swarm.id,
    taskId: first.task.id,
    workerId: 'worker-1',
    leaseToken: first.task.leaseToken,
    status: TASK_STATUSES.SUCCEEDED,
    result: { summary: 'audit complete' },
  });
  const stillPaused = await orchestrator.getProgress(swarm.id);
  assert.equal(stillPaused.swarm.status, SWARM_STATUSES.PAUSED);
  assert.equal(stillPaused.progress.counts.queued, 1);

  const resumed = await orchestrator.resumeSwarm({ swarmId: swarm.id });
  const second = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-3',
  });
  assert.equal(resumed.swarm.status, SWARM_STATUSES.RUNNING);
  assert.equal(second.task.key, 'audit-b');
});

test('budget deferral releases the lease, preserves the task and pauses the swarm', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'audit-a', role: TASK_ROLES.READ_ONLY },
      { key: 'audit-b', role: TASK_ROLES.READ_ONLY },
    ],
    maxConcurrency: 1,
  });
  const claim = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-budget',
  });
  const deferred = await orchestrator.deferTask({
    swarmId: swarm.id,
    taskId: claim.task.id,
    workerId: 'worker-1',
    leaseToken: claim.task.leaseToken,
    reason: 'swarm_project_budget_blocked:daily_budget_exceeded',
  });

  assert.equal(deferred.swarm.status, SWARM_STATUSES.PAUSED);
  assert.equal(deferred.task.status, TASK_STATUSES.QUEUED);
  assert.equal(deferred.task.claimId, null);
  assert.equal(deferred.task.leaseOwner, null);
  assert.equal(deferred.task.leaseToken, null);
  assert.equal(deferred.task.attemptCount, 0);
  assert.equal(deferred.progress.counts.queued, 2);

  const blocked = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-after-budget',
  });
  assert.equal(blocked.task, null);
  assert.equal(blocked.reason, 'swarm_paused');
});

test('claim-time reservations atomically prevent a second worker from oversubscribing budget', async () => {
  const { orchestrator } = createHarness();
  const swarm = await createBasicSwarm(orchestrator, {
    tasks: [
      { key: 'audit-a', role: TASK_ROLES.READ_ONLY },
      { key: 'audit-b', role: TASK_ROLES.READ_ONLY },
    ],
    maxConcurrency: 2,
  });
  const budgetPolicy = {
    projectDailyBudgetUsd: 0.25,
    companyDailyBudgetUsd: 1,
    defaultReservationUsd: 0.25,
  };
  const first = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-1',
    claimId: 'claim-budget-a',
    budgetPolicy,
  });
  const second = await orchestrator.claimNextTask({
    swarmId: swarm.id,
    workerId: 'worker-2',
    claimId: 'claim-budget-b',
    budgetPolicy,
  });
  const progress = await orchestrator.getProgress(swarm.id);

  assert.equal(first.task.key, 'audit-a');
  assert.equal(second.task, null);
  assert.equal(second.reason, 'project_budget_limit');
  assert.equal(progress.swarm.status, SWARM_STATUSES.PAUSED);
  assert.equal(progress.progress.counts.running, 1);
  assert.equal(progress.progress.counts.queued, 1);
  assert.equal(progress.tasks.find((task) => task.key === 'audit-b').attemptCount, 0);
});

test('aggregate progress reports statuses, roles and active writers', () => {
  const progress = aggregateTaskProgress([
    { id: '1', status: TASK_STATUSES.RUNNING, role: TASK_ROLES.WRITER },
    { id: '2', status: TASK_STATUSES.RUNNING, role: TASK_ROLES.REVIEWER },
    { id: '3', status: TASK_STATUSES.SUCCEEDED, role: TASK_ROLES.READ_ONLY },
    { id: '4', status: TASK_STATUSES.CANCELLED, role: TASK_ROLES.INTEGRATOR },
  ]);
  assert.deepEqual(progress.counts, {
    total: 4,
    queued: 0,
    blocked: 0,
    running: 2,
    succeeded: 1,
    failed: 0,
    cancelled: 1,
  });
  assert.equal(progress.runningWriters, 1);
  assert.equal(progress.progressPercent, 50);
  assert.equal(progress.byRole[TASK_ROLES.REVIEWER], 1);
});

test('rejects invalid completion state and lease duration before repository calls', async () => {
  const { orchestrator } = createHarness();
  await assert.rejects(
    orchestrator.finishTask({
      swarmId: 'swarm-1',
      taskId: 'task-1',
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      status: TASK_STATUSES.RUNNING,
    }),
    (error) => error.code === 'codex_swarm_invalid_completion_status',
  );
  await assert.rejects(
    orchestrator.claimNextTask({
      swarmId: 'swarm-1',
      workerId: 'worker-1',
      claimId: 'claim-1',
      leaseMs: 100,
    }),
    (error) => error.code === 'codex_swarm_invalid_limit',
  );
});

test('requires injectable repository dependencies and validates Prisma adapter shape', () => {
  assert.throws(
    () => new CodexSwarmOrchestrator(),
    (error) => error.code === 'codex_swarm_repository_required',
  );
  assert.throws(
    () => createPrismaSwarmRepository({}),
    (error) => error.code === 'codex_swarm_repository_invalid',
  );
});
