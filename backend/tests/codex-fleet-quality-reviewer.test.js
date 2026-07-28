'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fleetQa = require('../src/services/codex/fleet-quality-reviewer');
const {
  TASK_ROLES,
  TASK_STATUSES,
} = require('../src/services/codex/swarm-orchestrator');

const SHAS = {
  base: '0'.repeat(40),
  one: 'a'.repeat(40),
  two: 'b'.repeat(40),
  three: 'c'.repeat(40),
};

function fakePrisma(project, activeSwarm = null) {
  const state = {
    project: structuredClone(project),
    activeSwarm: activeSwarm ? structuredClone(activeSwarm) : null,
  };
  return {
    state,
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === state.project.id && (!where.userId || where.userId === state.project.userId)
          ? structuredClone(state.project)
          : null
      ),
      update: async ({ data }) => {
        state.project = { ...state.project, ...structuredClone(data) };
        return structuredClone(state.project);
      },
    },
    codexSwarm: {
      findFirst: async () => (
        state.activeSwarm ? structuredClone(state.activeSwarm) : null
      ),
    },
    codexDepartmentPool: {
      findFirst: async () => ({
        id: 'pool-trust',
        projectId: state.project.id,
        departmentId: 'trust',
        size: 2,
        dailyBudgetUsd: 5,
        enabled: true,
      }),
      findUnique: async () => ({
        id: 'pool-trust',
        projectId: state.project.id,
        departmentId: 'trust',
        size: 2,
        dailyBudgetUsd: 5,
        enabled: true,
      }),
    },
    codexSwarmTask: {
      findMany: async () => [],
    },
    codexRunMetric: {
      findMany: async () => [],
      aggregate: async () => ({
        _sum: {
          costOriginalUsd: 0,
          costAppliedUsd: 0,
        },
      }),
    },
    codexUsageEntry: {
      findMany: async () => [],
    },
  };
}

function fakeRunner({ tokenPatch = false } = {}) {
  const calls = [];
  const runner = {
    calls,
    exec: async (_projectId, command) => {
      calls.push(command);
      const args = command.slice(1);
      if (args[0] === 'rev-parse') {
        const sha = String(args[1]).replace(/\^1$/, '');
        const parents = {
          [SHAS.one]: SHAS.base,
          [SHAS.two]: SHAS.one,
          [SHAS.three]: SHAS.two,
        };
        return { exitCode: 0, stdout: `${parents[sha] || SHAS.base}\n`, stderr: '' };
      }
      if (args[0] === 'merge-base') return { exitCode: 0, stdout: '', stderr: '' };
      if (args[0] === 'diff' && args.includes('--stat')) {
        return { exitCode: 0, stdout: ' src/auth.js | 4 +++-\n 1 file changed\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--name-only')) {
        return { exitCode: 0, stdout: 'src/auth.js\0.env\0', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('src/auth.js')) {
        const fakeToken = ['ghp_', 'a'.repeat(36)].join('');
        const added = tokenPatch
          ? `+const token = "${fakeToken}";`
          : '+if (!user) return forbidden();';
        return {
          exitCode: 0,
          stdout: `diff --git a/src/auth.js b/src/auth.js\n@@ -1 +1 @@\n-allow();\n${added}\n`,
          stderr: '',
        };
      }
      throw new Error(`unexpected runner command: ${command.join(' ')}`);
    },
  };
  return runner;
}

const PROJECT = {
  id: 'project-1',
  userId: 'user-1',
  name: 'SiraGPT',
  brief: {},
};

test('every Kth merged checkpoint runs qa_reviewer and appends findings to the active DAG', async () => {
  const activeSwarm = {
    id: 'swarm-1',
    status: 'running',
    tasks: [{
      id: 'task-integrate',
      key: 'integrate-main',
      role: TASK_ROLES.INTEGRATOR,
      status: TASK_STATUSES.RUNNING,
      ordinal: 4,
      result: { planRunId: 'plan-3' },
    }],
  };
  const prisma = fakePrisma(PROJECT, activeSwarm);
  const runner = fakeRunner();
  const appended = [];
  let reviewerCalls = 0;
  const deps = {
    runner,
    idFactory: () => 'review-1',
    agentSdk: {
      runSubagent: async ({ name, task, context }) => {
        reviewerCalls += 1;
        assert.equal(name, 'qa_reviewer');
        assert.match(task, /SOLO JSON válido/);
        assert.match(context, /src\/auth\.js/);
        assert.doesNotMatch(context, /\.env/);
        return {
          ok: true,
          result: JSON.stringify({
            findings: [{
              title: 'Ruta sin autorización',
              severity: 'high',
              category: 'security',
              file: 'src/auth.js',
              line: 12,
              evidence: 'La rama permite continuar cuando user es nulo.',
              remediation: 'Rechazar el request sin usuario y cubrirlo con una prueba.',
            }],
          }),
        };
      },
    },
    orchestrator: {
      appendTasks: async (input) => {
        appended.push(input);
        return {
          swarm: { id: 'swarm-1' },
          appended: input.tasks,
          replayed: false,
        };
      },
    },
    enqueueSwarm: async () => ({ id: 'qa-job' }),
  };
  const env = {
    NODE_ENV: 'test',
    CODEX_FLEET_QA_ENABLED: '1',
    CODEX_FLEET_QA_EVERY_MERGES: '3',
  };
  const now = () => new Date('2026-07-28T18:00:00.000Z');

  const first = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-1', planRunId: 'plan-1' },
    mergeSha: SHAS.one,
    deps,
    env,
    now,
  });
  const second = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-2', planRunId: 'plan-2' },
    mergeSha: SHAS.two,
    deps,
    env,
    now,
  });
  const third = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-3', planRunId: 'plan-3' },
    mergeSha: SHAS.three,
    deps,
    env,
    now,
  });

  assert.equal(first.action, 'not_due');
  assert.equal(second.action, 'not_due');
  assert.equal(third.action, 'reviewed');
  assert.equal(third.mergeCount, 3);
  assert.equal(third.findings, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].swarmId, 'swarm-1');
  assert.equal(appended[0].tasks[0].role, TASK_ROLES.INTEGRATOR);
  assert.deepEqual(appended[0].tasks[0].dependsOn, ['integrate-main']);
  assert.equal(appended[0].tasks[0].input.source, 'fleet_qa');
  assert.match(appended[0].tasks[0].input.objective, /prueba de regresión/);

  const state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
  assert.equal(state.lastReviewedSha, SHAS.three);
  assert.equal(state.mergesSinceReview, 0);
  assert.equal(state.inFlight, null);
  assert.equal(state.lastReview.tasksCreated, 1);
});

test('fleet QA is opt-in in every environment', () => {
  assert.equal(fleetQa.enabled({ NODE_ENV: 'production' }), false);
  assert.equal(fleetQa.enabled({ NODE_ENV: 'production', CODEX_FLEET_QA_ENABLED: '1' }), true);
});

test('fleet QA fails closed in production when project settings cannot be read', async () => {
  const prisma = fakePrisma(PROJECT);
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-settings' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
    },
    env: {
      NODE_ENV: 'production',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
  });
  assert.equal(result.action, 'budget_blocked');
  assert.equal(result.reason, 'fleet_qa_project_settings_store_unavailable');
});

test('fleet QA enforces the project budget before invoking the reviewer', async () => {
  const prisma = fakePrisma(PROJECT);
  let reviewerCalls = 0;
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-project-budget' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
      checkProjectBudget: async () => ({
        allowed: false,
        reason: 'daily_budget_exceeded',
        dailyBudgetUsd: 1,
        costTodayUsd: 1,
      }),
      checkBudget: async () => ({
        allowed: true,
        dailyBudgetUsd: 100,
        costTodayUsd: 1,
      }),
      agentSdk: {
        runSubagent: async () => {
          reviewerCalls += 1;
          return { ok: true, result: '{"findings":[]}' };
        },
      },
    },
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
  });
  assert.equal(result.action, 'budget_blocked');
  assert.equal(result.reason, 'daily_budget_exceeded');
  assert.equal(reviewerCalls, 0);
});

test('finding task keys are stable when reviewer titles change', () => {
  const finding = {
    title: 'First title',
    severity: 'high',
    category: 'security',
    file: 'src/auth.js',
    line: 12,
    evidence: 'The route allows anonymous access.',
    remediation: 'Reject requests without an authenticated user.',
  };
  const input = {
    reviewId: 'review-stable',
    baseSha: SHAS.base,
    headSha: SHAS.one,
  };
  const first = fleetQa.tasksFromFindings({
    ...input,
    findings: [finding],
  })[0];
  const renamed = fleetQa.tasksFromFindings({
    ...input,
    findings: [{ ...finding, title: 'Different wording for the same finding' }],
  })[0];
  assert.equal(first.key, renamed.key);
  assert.notEqual(first.title, renamed.title);
});

test('an enqueue failure retries the persisted swarm without rerunning the reviewer', async () => {
  const prisma = fakePrisma(PROJECT, {
    id: 'swarm-1',
    status: 'running',
    tasks: [],
  });
  let reviewerCalls = 0;
  let appendCalls = 0;
  let enqueueCalls = 0;
  let budgetChecks = 0;
  let budgetAllowed = true;
  const deps = {
    runner: fakeRunner(),
    idFactory: () => 'review-enqueue',
    checkBudget: async () => {
      budgetChecks += 1;
      return budgetAllowed
        ? { allowed: true, dailyBudgetUsd: 5, costTodayUsd: 1 }
        : { allowed: false, reason: 'daily_budget_exceeded', dailyBudgetUsd: 5, costTodayUsd: 5 };
    },
    agentSdk: {
      runSubagent: async () => {
        reviewerCalls += 1;
        return {
          ok: true,
          result: JSON.stringify({
            findings: [{
              title: 'Falta autorización',
              severity: 'high',
              category: 'security',
              file: 'src/auth.js',
              line: 12,
              evidence: 'La ruta permite continuar sin usuario autenticado.',
              remediation: 'Rechazar la petición y agregar una prueba focal.',
            }],
          }),
        };
      },
    },
    orchestrator: {
      appendTasks: async ({ tasks }) => {
        appendCalls += 1;
        return {
          swarm: { id: 'swarm-1' },
          appended: tasks,
          replayed: false,
        };
      },
    },
    enqueueSwarm: async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) {
        const state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
        assert.equal(state.pendingEnqueue.swarmId, 'swarm-1');
        assert.equal(state.lastReviewedSha, null);
        throw new Error('redis unavailable');
      }
      return { id: 'qa-job' };
    },
  };
  const input = {
    prisma,
    project: PROJECT,
    run: { id: 'run-enqueue' },
    mergeSha: SHAS.one,
    deps,
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
    now: () => new Date('2026-07-28T18:00:00.000Z'),
  };
  const deferred = await fleetQa.reviewMergedCheckpoint(input);
  assert.equal(deferred.action, 'review_deferred');
  let state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
  assert.equal(state.lastReviewedSha, null);
  assert.equal(state.mergesSinceReview, 1);
  assert.equal(state.inFlight, null);
  assert.equal(state.pendingEnqueue.swarmId, 'swarm-1');
  assert.equal(state.pendingEnqueue.taskKeys.length, 1);

  budgetAllowed = false;
  const blocked = await fleetQa.reviewMergedCheckpoint(input);
  assert.equal(blocked.action, 'budget_blocked');
  assert.equal(blocked.reason, 'daily_budget_exceeded');
  assert.equal(enqueueCalls, 1, 'a pending swarm is never re-enqueued past the kill-switch');

  budgetAllowed = true;
  const retried = await fleetQa.reviewMergedCheckpoint(input);
  assert.equal(retried.action, 'reviewed');
  assert.equal(retried.retriedEnqueue, true);
  assert.equal(reviewerCalls, 1);
  assert.equal(appendCalls, 1);
  assert.equal(enqueueCalls, 2);
  assert.equal(budgetChecks, 4);
  state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
  assert.equal(state.lastReviewedSha, SHAS.one);
  assert.equal(state.mergesSinceReview, 0);
  assert.equal(state.pendingEnqueue, null);
});

test('a budget change after review blocks remediation before tasks are materialized', async () => {
  const prisma = fakePrisma(PROJECT, {
    id: 'swarm-budget-enqueue',
    status: 'running',
    tasks: [],
  });
  let appendCalls = 0;
  let enqueueCalls = 0;
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-budget-enqueue' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
      idFactory: () => 'review-budget-enqueue',
      checkBudget: async ({ phase }) => (
        phase === 'materialize'
          ? { allowed: false, reason: 'daily_budget_exceeded', dailyBudgetUsd: 5, costTodayUsd: 5 }
          : { allowed: true, dailyBudgetUsd: 5, costTodayUsd: 4 }
      ),
      agentSdk: {
        runSubagent: async () => ({
          ok: true,
          result: JSON.stringify({
            findings: [{
              title: 'Validar autorización',
              severity: 'high',
              category: 'security',
              file: 'src/auth.js',
              line: 12,
              evidence: 'Falta un guard antes del handler.',
              remediation: 'Agregar guard y prueba focal.',
            }],
          }),
        }),
      },
      orchestrator: {
        appendTasks: async ({ tasks }) => {
          appendCalls += 1;
          return {
            swarm: { id: 'swarm-budget-enqueue' },
            appended: tasks,
            replayed: false,
          };
        },
      },
      enqueueSwarm: async () => {
        enqueueCalls += 1;
        return { id: 'must-not-run' };
      },
    },
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
    now: () => new Date('2026-07-28T18:00:00.000Z'),
  });

  assert.equal(result.action, 'review_deferred');
  assert.match(result.error, /fleet_qa_materialize_budget_blocked:daily_budget_exceeded/);
  assert.equal(result.swarmId, null);
  assert.equal(result.tasksCreated, 0);
  assert.equal(appendCalls, 0, 'an active worker cannot claim tasks before the final budget gate');
  assert.equal(enqueueCalls, 0);
  const state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
  assert.equal(state.pendingEnqueue, null);
  assert.equal(state.inFlight, null);
  assert.equal(state.lastReviewedSha, null);
});

test('runtime budget rejection stops fleet QA after the accounted turn', async () => {
  const prisma = fakePrisma(PROJECT);
  let budgetChecks = 0;
  let usageCalls = 0;
  let usageAttribution = null;
  let reviewerAdvanced = false;
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-budget' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
      idFactory: () => 'review-budget',
      checkBudget: async ({ phase }) => {
        budgetChecks += 1;
        return phase === 'preflight'
          ? { allowed: true, dailyBudgetUsd: 5, costTodayUsd: 4.9 }
          : { allowed: false, reason: 'daily_budget_exceeded', dailyBudgetUsd: 5, costTodayUsd: 5.1 };
      },
      onUsage: async (_usage, attribution) => {
        usageCalls += 1;
        usageAttribution = attribution;
        await Promise.resolve();
        return { costOriginalUsd: 0.2 };
      },
      agentSdk: {
        runSubagent: async ({ deps }) => {
          await deps.onUsage({ tokensIn: 10, tokensOut: 5, costUsd: 0.2 });
          reviewerAdvanced = true;
          return { ok: true, result: '{"findings":[]}' };
        },
      },
    },
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
    now: () => new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(result.action, 'review_failed');
  assert.match(result.error, /daily_budget_exceeded/);
  assert.equal(budgetChecks, 2);
  assert.equal(usageCalls, 1);
  assert.equal(usageAttribution.departmentPoolId, 'pool-trust');
  assert.equal(usageAttribution.reviewId, 'review-budget');
  assert.equal(reviewerAdvanced, false);
  assert.equal(
    fleetQa.normalizeState(prisma.state.project.brief.fleetQa).lastReviewedSha,
    null,
  );
});

test('a clean QA review advances the checkpoint without creating DAG tasks', async () => {
  const prisma = fakePrisma(PROJECT);
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-clean' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
      idFactory: () => 'review-clean',
      agentSdk: {
        runSubagent: async () => ({ ok: true, result: '{"findings":[]}' }),
      },
    },
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
    now: () => new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(result.action, 'reviewed');
  assert.equal(result.findings, 0);
  assert.equal(result.tasksCreated, 0);
  assert.equal(
    fleetQa.normalizeState(prisma.state.project.brief.fleetQa).lastReviewedSha,
    SHAS.one,
  );
});

test('invalid reviewer output keeps the merge range pending for a later retry', async () => {
  const prisma = fakePrisma(PROJECT);
  const result = await fleetQa.reviewMergedCheckpoint({
    prisma,
    project: PROJECT,
    run: { id: 'run-invalid' },
    mergeSha: SHAS.one,
    deps: {
      runner: fakeRunner(),
      idFactory: () => 'review-invalid',
      agentSdk: {
        runSubagent: async () => ({ ok: true, result: 'No encontré nada.' }),
      },
    },
    env: {
      NODE_ENV: 'test',
      CODEX_FLEET_QA_ENABLED: '1',
      CODEX_FLEET_QA_EVERY_MERGES: '1',
    },
    now: () => new Date('2026-07-28T18:00:00.000Z'),
  });
  assert.equal(result.action, 'review_failed');
  assert.match(result.error, /invalid_review_json/);
  const state = fleetQa.normalizeState(prisma.state.project.brief.fleetQa);
  assert.equal(state.mergesSinceReview, 1);
  assert.equal(state.lastReviewedSha, null);
  assert.equal(state.inFlight, null);
});

test('accumulated diff excludes sensitive paths and redacts detected tokens', async () => {
  const runner = fakeRunner({ tokenPatch: true });
  const diff = await fleetQa.collectAccumulatedDiff({
    runner,
    projectId: 'project-1',
    baseSha: SHAS.base,
    headSha: SHAS.one,
  });
  assert.deepEqual(diff.files, ['src/auth.js']);
  assert.equal(diff.excludedFiles, 1);
  assert.doesNotMatch(diff.patch, /ghp_a{36}/);
  assert.ok(
    runner.calls.every((command) => !command.includes('.env')),
    'sensitive files must never be requested from the runner',
  );
});

test('finding normalization rejects files outside the accumulated diff', () => {
  const findings = fleetQa.normalizeFindings({
    findings: [
      {
        title: 'Speculative unrelated issue',
        severity: 'high',
        category: 'logic',
        file: 'src/unrelated.js',
        evidence: 'The reviewer mentioned an unchanged file.',
        remediation: 'Rewrite the unrelated module.',
      },
      {
        title: 'Changed file issue',
        severity: 'medium',
        category: 'test',
        file: 'src/auth.js',
        evidence: 'The changed branch has no regression assertion.',
        remediation: 'Add one focused authorization regression test.',
      },
    ],
  }, ['src/auth.js']);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Changed file issue');
});
