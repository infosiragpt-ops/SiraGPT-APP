'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  dependencyContext,
  runReadOnlyTask,
  safeResult,
  startLeaseHeartbeat,
  waitForAutonomousRun,
} = require('../src/services/codex/swarm-runner');

test('dependency context includes only declared predecessors and stays bounded', () => {
  const text = dependencyContext([
    { key: 'a', title: 'A', status: 'succeeded', result: { summary: 'hallazgo A' } },
    { key: 'b', title: 'B', status: 'succeeded', result: { summary: 'hallazgo B' } },
  ], { dependsOn: ['a'] }, 200);
  assert.match(text, /hallazgo A/);
  assert.doesNotMatch(text, /hallazgo B/);
  assert.ok(text.length <= 200);
});

test('read-only execution rejects any specialist with write privileges', async () => {
  const sdk = {
    getSubagent: () => ({ readOnly: false }),
    runSubagent: async () => {
      throw new Error('must not run');
    },
  };
  await assert.rejects(
    runReadOnlyTask({
      task: { role: 'read-only', title: 'x', input: { agent: 'writer' }, dependsOn: [] },
      swarm: { metadata: {} },
      project: { id: 'p1', name: 'P' },
      tasks: [],
      runner: {},
      sdk,
      env: {},
      webSearch: async () => ({ results: [] }),
    }),
    /swarm_read_only_agent_required/,
  );
});

test('autonomous integration waits for the auto-continued build result', async () => {
  let tick = 0;
  const prisma = {
    codexRun: {
      findUnique: async () => ({ id: 'plan-1', status: tick < 1 ? 'running' : 'waiting_approval' }),
      findFirst: async () => {
        tick += 1;
        if (tick < 2) return null;
        return { id: 'build-1', planRunId: 'plan-1', status: tick < 3 ? 'running' : 'done', error: null };
      },
    },
  };
  let now = 0;
  const result = await waitForAutonomousRun({
    prisma,
    planRunId: 'plan-1',
    env: {
      CODEX_SWARM_INTEGRATION_TIMEOUT_MS: '60000',
      CODEX_SWARM_POLL_MS: '250',
    },
    clock: () => now,
    delay: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.buildRunId, 'build-1');
});

test('cancelling a swarm cancels both active plan and build runs', async () => {
  const cancelled = [];
  const prisma = {
    codexRun: {
      findUnique: async () => ({ id: 'plan-1', status: 'waiting_approval' }),
      findFirst: async () => ({ id: 'build-1', planRunId: 'plan-1', status: 'running' }),
    },
    codexSwarm: {
      findUnique: async () => ({
        status: 'cancelled',
        cancelRequestedAt: new Date('2026-07-27T12:00:00.000Z'),
      }),
    },
  };
  const result = await waitForAutonomousRun({
    prisma,
    planRunId: 'plan-1',
    swarmId: 'swarm-1',
    userId: 'user-1',
    runService: {
      cancelRun: async ({ runId }) => {
        cancelled.push(runId);
      },
    },
    env: {
      CODEX_SWARM_INTEGRATION_TIMEOUT_MS: '60000',
      CODEX_SWARM_POLL_MS: '250',
    },
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(cancelled.sort(), ['build-1', 'plan-1']);
});

test('integration timeout cancels active linked runs instead of leaving orphan work', async () => {
  const cancelled = [];
  let now = 0;
  const prisma = {
    codexRun: {
      findUnique: async () => ({ id: 'plan-1', status: 'waiting_approval' }),
      findFirst: async () => ({ id: 'build-1', planRunId: 'plan-1', status: 'running' }),
    },
  };
  const result = await waitForAutonomousRun({
    prisma,
    planRunId: 'plan-1',
    userId: 'user-1',
    runService: {
      cancelRun: async ({ runId }) => {
        cancelled.push(runId);
      },
    },
    env: {
      CODEX_SWARM_INTEGRATION_TIMEOUT_MS: '60000',
      CODEX_SWARM_POLL_MS: '10000',
    },
    clock: () => now,
    delay: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(cancelled.sort(), ['build-1', 'plan-1']);
});

test('lease heartbeat renews long-running task ownership and stops cleanly', async () => {
  const renewals = [];
  let tick = null;
  let cleared = null;
  const heartbeat = startLeaseHeartbeat({
    orchestrator: {
      renewTaskLease: async (args) => {
        renewals.push(args);
      },
    },
    swarmId: 'swarm-1',
    taskId: 'task-1',
    workerId: 'worker-1',
    leaseToken: 'lease-1',
    leaseMs: 15_000,
    intervalMs: 5_000,
    setIntervalFn: (callback) => {
      tick = callback;
      return { unref() {} };
    },
    clearIntervalFn: (timer) => {
      cleared = timer;
    },
  });
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].leaseToken, 'lease-1');
  await heartbeat.stop();
  assert.ok(cleared);
  assert.equal(heartbeat.error, null);
});

test('task results expose bounded summaries and usage without raw action payloads', () => {
  const result = safeResult({
    ok: true,
    agent: 'explorer',
    result: 'x'.repeat(20_000),
    steps: 4,
    toolCallsCount: 8,
    tokensIn: 100,
    tokensOut: 50,
    actions: [{ secret: 'do-not-persist' }],
  });
  assert.equal(result.summary.length, 12_000);
  assert.equal(result.tokensIn, 100);
  assert.equal('actions' in result, false);
});
