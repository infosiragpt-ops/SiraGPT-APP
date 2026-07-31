'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  processCodexRunJob,
  abortRun,
  executionContextForAdapter,
} = require('../src/services/codex/run-processor');
const { nativeCodexAdapter } = require('../src/services/codex/agent-adapters/native-codex-adapter');

// Fake prisma: one run + one project, mutable status.
function makeDeps({
  run,
  project,
  metric = null,
  userPlan = 'PRO',
} = {}) {
  const runRow = { id: 'run-1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued', ...run };
  const projRow = { id: 'p1', userId: 'u1', name: 'Demo', ...project };
  const metricState = { row: metric ? structuredClone(metric) : null };
  const usageState = { rows: [] };
  const events = [];
  const prisma = {
    codexRun: {
      async findUnique({ where }) { return where.id === runRow.id ? { ...runRow } : null; },
      async update({ where, data }) { if (where.id === runRow.id) Object.assign(runRow, data); return { ...runRow }; },
      // Status-guarded terminal transition: only flips when the WHERE matches.
      async updateMany({ where, data }) {
        const match = where.id === runRow.id && (where.status === undefined || runRow.status === where.status);
        if (!match) return { count: 0 };
        Object.assign(runRow, data);
        return { count: 1 };
      },
    },
    codexProject: {
      async findUnique({ where }) { return where.id === projRow.id ? { ...projRow } : null; },
    },
    codexRunMetric: {
      async findUnique({ where }) {
        return metricState.row?.runId === where.runId ? structuredClone(metricState.row) : null;
      },
      async upsert({ create, update }) {
        if (!metricState.row) {
          metricState.row = { id: 'metric-1', ...structuredClone(create) };
          return structuredClone(metricState.row);
        }
        for (const [key, value] of Object.entries(update)) {
          if (value && typeof value === 'object' && 'increment' in value) {
            metricState.row[key] = Number(metricState.row[key] || 0) + Number(value.increment || 0);
          } else {
            metricState.row[key] = value;
          }
        }
        return structuredClone(metricState.row);
      },
    },
    codexUsageEntry: {
      async create({ data }) {
        const row = {
          id: `usage-${usageState.rows.length + 1}`,
          createdAt: new Date('2026-06-13T12:00:00.000Z'),
          ...structuredClone(data),
        };
        usageState.rows.push(row);
        return structuredClone(row);
      },
      async findUnique({ where }) {
        const row = usageState.rows.find(
          (candidate) => candidate.idempotencyKey === where.idempotencyKey,
        );
        return row ? structuredClone(row) : null;
      },
    },
    user: {
      async findUnique() { return { plan: userPlan }; },
    },
  };
  const eventStore = {
    async appendEvent(runId, type, data) { events.push({ runId, type, data }); return { runId, type, data, seq: events.length }; },
  };
  const clock = () => new Date('2026-06-13T12:00:00.000Z');
  return {
    prisma,
    eventStore,
    clock,
    events,
    runRow,
    metricState,
    usageState,
  };
}

test('build run: queued → running → done with run_status events in order', async () => {
  const d = makeDeps();
  let nativeInput;
  const loop = async (args) => { nativeInput = args; return { status: 'done' }; };
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock });
  assert.equal(res.status, 'done');
  assert.equal(d.runRow.status, 'done');
  assert.ok(d.runRow.startedAt && d.runRow.finishedAt);
  assert.equal(nativeInput.run.userId, 'u1');
  assert.equal(nativeInput.project.name, 'Demo');
  assert.equal(nativeInput.deps.prisma, d.prisma);
  assert.equal(nativeInput.deps.eventStore, d.eventStore);
  const statuses = d.events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running', 'done']);
});

test('fleet QA starts only after the merged run is durably terminal', async () => {
  const d = makeDeps();
  const reviews = [];
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runner: { exec: async () => ({ exitCode: 0 }) },
    runAgentLoop: async () => ({
      status: 'done',
      close: {
        branchFinalization: {
          merge: { status: 'merged', commitSha: 'a'.repeat(40) },
        },
      },
    }),
    fleetQualityReviewer: {
      async reviewMergedCheckpoint(input) {
        assert.equal(d.runRow.status, 'done');
        reviews.push(input);
        return {
          action: 'reviewed',
          mergeCount: 1,
          findings: 0,
          tasksCreated: 0,
        };
      },
    },
    clock: d.clock,
    env: { NODE_ENV: 'test', CODEX_FLEET_QA_ENABLED: '1' },
  });
  assert.equal(res.status, 'done');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].mergeSha, 'a'.repeat(40));
  assert.ok(
    d.events.findIndex((event) => event.type === 'run_status' && event.data.status === 'done')
      < d.events.findIndex((event) => event.type === 'narrative_delta'),
  );
});

test('fleet QA usage is awaited and attributed to the Trust pool ledger', async () => {
  const d = makeDeps({
    metric: {
      id: 'metric-1',
      runId: 'run-1',
      tokensIn: 100,
      tokensOut: 20,
      model: 'old-model',
      costUsd: 1,
      costSource: 'provider_exact',
      costOriginalUsd: 1,
      costAppliedUsd: 1,
      costInputUsd: 0.6,
      costOutputUsd: 0.4,
    },
  });
  let usageVisibleInsideReviewer = false;
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runner: { exec: async () => ({ exitCode: 0 }) },
    runAgentLoop: async () => ({
      status: 'done',
      close: {
        branchFinalization: {
          merge: { status: 'merged', commitSha: 'a'.repeat(40) },
        },
      },
    }),
    fleetQualityReviewer: {
      async reviewMergedCheckpoint({ deps }) {
        const accounted = await deps.onUsage({
          tokensIn: 10,
          tokensOut: 5,
          model: 'qa-model',
        }, {
          departmentPoolId: 'pool-trust',
          reviewId: 'review-1',
        });
        usageVisibleInsideReviewer = d.usageState.rows[0]?.costOriginalUsd === 0.25;
        assert.equal(accounted.costOriginalUsd, 0.25);
        return {
          action: 'reviewed',
          mergeCount: 1,
          findings: 0,
          tasksCreated: 0,
        };
      },
    },
    fleetQaCostResolver: async () => ({
      costUsd: 0.25,
      costInputUsd: 0.15,
      costOutputUsd: 0.1,
      costSource: 'provider_exact',
    }),
    clock: d.clock,
    env: { NODE_ENV: 'test', CODEX_FLEET_QA_ENABLED: '1' },
  });
  assert.equal(res.status, 'done');
  assert.equal(usageVisibleInsideReviewer, true);
  assert.equal(d.metricState.row.costOriginalUsd, 1, 'originating run metric remains unchanged');
  assert.equal(d.usageState.rows.length, 1);
  assert.equal(d.usageState.rows[0].projectId, 'p1');
  assert.equal(d.usageState.rows[0].departmentPoolId, 'pool-trust');
  assert.equal(d.usageState.rows[0].source, 'fleet_qa');
  assert.equal(d.usageState.rows[0].sourceId, 'review-1');
  assert.equal(d.usageState.rows[0].tokensIn, 10);
  assert.equal(d.usageState.rows[0].tokensOut, 5);
});

test('post-terminal fleet QA has an independent hard timeout', async () => {
  const d = makeDeps();
  let qaSignal;
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runner: { exec: async () => ({ exitCode: 0 }) },
    runAgentLoop: async () => ({
      status: 'done',
      close: {
        branchFinalization: {
          merge: { status: 'merged', commitSha: 'a'.repeat(40) },
        },
      },
    }),
    fleetQualityReviewer: {
      reviewMergedCheckpoint({ deps }) {
        qaSignal = deps.signal;
        return new Promise(() => {});
      },
    },
    fleetQaTimeoutMs: 20,
    clock: d.clock,
    env: { NODE_ENV: 'test', CODEX_FLEET_QA_ENABLED: '1' },
  });
  assert.equal(res.status, 'done');
  assert.equal(qaSignal.aborted, true);
  assert.equal(res.fleetQaResult.action, 'review_failed');
  assert.match(res.fleetQaResult.error, /fleet QA exceeded 20ms/);
});

test('post-terminal fleet QA accepts an independent cancellation signal', async () => {
  const d = makeDeps();
  const cancellation = new AbortController();
  let qaSignal;
  const processing = processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runner: { exec: async () => ({ exitCode: 0 }) },
    runAgentLoop: async () => ({
      status: 'done',
      close: {
        branchFinalization: {
          merge: { status: 'merged', commitSha: 'a'.repeat(40) },
        },
      },
    }),
    fleetQualityReviewer: {
      reviewMergedCheckpoint({ deps }) {
        qaSignal = deps.signal;
        return new Promise(() => {});
      },
    },
    fleetQaSignal: cancellation.signal,
    fleetQaTimeoutMs: 5_000,
    clock: d.clock,
    env: { NODE_ENV: 'test', CODEX_FLEET_QA_ENABLED: '1' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  cancellation.abort(new Error('operator cancelled QA'));
  const res = await processing;
  assert.equal(qaSignal.aborted, true);
  assert.equal(res.fleetQaResult.action, 'review_failed');
  assert.match(res.fleetQaResult.error, /operator cancelled QA/);
});

test('build processor provisions a run worktree before handing the scoped runner to every tool', async () => {
  const d = makeDeps();
  const calls = [];
  const scopedRunner = { runScope: { project: 'p1', run: 'run-1' } };
  const runner = {
    async createWorktree(project, run, baseBranch) {
      calls.push(['create', project, run, baseBranch]);
      return { ok: true, runBranch: `run/${run}` };
    },
    forRun(run, project) {
      calls.push(['scope', run, project]);
      return scopedRunner;
    },
  };
  let loopRunner;
  const checkpointService = {
    projectBaseBranch: () => 'main',
    async prepareRunBranch({ run, project, deps }) {
      calls.push(['branch', deps.runner]);
      await deps.runner.createWorktree(project.id, run.id, 'main');
      return { ok: true, worktree: true };
    },
  };
  const result = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runner,
    checkpointService,
    runAgentLoop: async ({ deps }) => {
      loopRunner = deps.runner;
      return { status: 'done' };
    },
    clock: d.clock,
    env: {
      NODE_ENV: 'test',
      CODEX_RUN_BRANCHES: '1',
      CODEX_RUN_WORKTREES: '1',
    },
  });

  assert.equal(result.status, 'done');
  assert.equal(calls[0][0], 'branch');
  assert.equal(calls[0][1], runner);
  assert.deepEqual(calls[1], ['create', 'p1', 'run-1', 'main']);
  assert.deepEqual(calls[2], ['scope', 'run-1', 'p1']);
  assert.equal(loopRunner, scopedRunner);
});

test('boot resume pointer reloads the bounded loop state from the session artifact', async () => {
  const d = makeDeps();
  let nativeInput;
  const loopState = {
    summary: 'La API ya está implementada.',
    tailMessages: [{ role: 'user', content: 'continúa con las pruebas' }],
    state: { verifyRounds: 1 },
  };
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: async (args) => { nativeInput = args; return { status: 'done' }; },
    sessionService: {
      async readSnapshot() {
        return {
          version: 1,
          projectId: 'p1',
          sessionId: 'run-1',
          cursorSeq: 7,
          checkpointSha: 'deadbee',
          loopState,
        };
      },
    },
    resumeSnapshot: { sessionId: 'run-1', cursorSeq: 7, checkpointSha: 'deadbee' },
    clock: d.clock,
    env: { NODE_ENV: 'test' },
  });

  assert.equal(res.status, 'done');
  assert.deepEqual(nativeInput.deps.resumeSnapshot, loopState);
});

test('plan run ends in waiting_approval with no finishedAt', async () => {
  const d = makeDeps({ run: { mode: 'plan' } });
  const loop = async ({ run }) => { assert.equal(run.mode, 'plan'); return { status: 'waiting_approval' }; };
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock });
  assert.equal(res.status, 'waiting_approval');
  assert.equal(d.runRow.status, 'waiting_approval');
  assert.equal(d.runRow.finishedAt, null);
  const statuses = d.events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running', 'waiting_approval']);
});

test('auto-executable plan continues into build inside the backend', async () => {
  const d = makeDeps({
    run: {
      mode: 'plan',
      prompt: '[SIRAGPT_AUTOEXEC_V1]\nIntegra OpenClaw y construye frontend, backend y pruebas durante horas.',
    },
  });
  let nativeInput;
  const created = [];
  const loop = async (args) => {
    nativeInput = args;
    return { status: 'waiting_approval' };
  };
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: loop,
    runService: {
      async createRun(args) {
        created.push(args);
        return { id: 'build-auto', status: 'queued' };
      },
    },
    clock: d.clock,
    env: {},
  });

  assert.equal(res.status, 'waiting_approval');
  assert.equal(res.autoContinuedRunId, 'build-auto');
  assert.equal(created.length, 1);
  assert.equal(created[0].mode, 'build');
  assert.equal(created[0].planRunId, 'run-1');
  assert.equal(created[0].autoExecute, true);
  assert.doesNotMatch(nativeInput.run.prompt, /SIRAGPT_AUTOEXEC/);
  assert.equal(nativeInput.deps.env.CODEX_RUN_TIMEOUT_MS, String(4 * 60 * 60_000));
  assert.equal(nativeInput.deps.env.CODEX_MAX_STEPS, '120');
  assert.equal(nativeInput.deps.env.CODEX_VERIFY_DEV_SERVER, '1');
  assert.match(nativeInput.deps.openclawPromptBlock, /OpenClaw-Level Runtime Policy/);
  assert.ok(d.events.some((event) => event.type === 'auto_continue' && event.data.buildRunId === 'build-auto'));
});

test('a thrown loop becomes a captured error (no throw out, no zombie)', async () => {
  const d = makeDeps();
  const loop = async () => { throw new Error('LLM exploded'); };
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock });
  assert.equal(res.status, 'error');
  assert.match(res.error, /LLM exploded/);
  assert.equal(d.runRow.status, 'error');
  assert.equal(d.events.filter((e) => e.type === 'run_status').at(-1).data.status, 'error');
});

test('out-of-band cancellation finalizes cancelled WITHOUT a duplicate run_status', async () => {
  const d = makeDeps();
  let terminalPublishes = 0;
  // Loop returns done, but the row was flipped to cancelled mid-flight.
  const loop = async () => { d.runRow.status = 'cancelled'; return { status: 'done' }; };
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: loop,
    clock: d.clock,
    triggers: { async publish() { terminalPublishes += 1; return {}; } },
  });
  assert.equal(res.status, 'cancelled');
  // Only the 'running' run_status is emitted here; cancelRun owns 'cancelled'.
  const statuses = d.events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running']);
  assert.equal(terminalPublishes, 0);
});

test('cancel landing after the isCancelled() check is not clobbered and emits no terminal run_status', async () => {
  // Simulate cancelRun flipping the row to `cancelled` in the narrow window
  // AFTER the processor's post-loop isCancelled() check but BEFORE its guarded
  // terminal write. The guarded updateMany (where status:'running') must no-op,
  // so the row stays `cancelled` and no duplicate run_status is emitted.
  const runRow = { id: 'run-1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued' };
  const events = [];
  let cancelFlips = 0;
  let runningReads = 0;
  const prisma = {
    codexRun: {
      async findUnique({ where }) {
        if (where.id !== runRow.id) return null;
        // Snapshot BEFORE mutating so the post-loop isCancelled() observes the
        // pre-cancel `running` value (returns false), then cancelRun lands: the
        // row is `cancelled` by the time the guarded terminal write runs.
        const snapshot = { ...runRow };
        if (runRow.status === 'running') {
          runningReads += 1;
          if (runningReads === 2) {
            cancelFlips += 1;
            runRow.status = 'cancelled'; // flips just AFTER the cancellation check
          }
        }
        return snapshot;
      },
      async update({ where, data }) { if (where.id === runRow.id) Object.assign(runRow, data); return { ...runRow }; },
      async updateMany({ where, data }) {
        const match = where.id === runRow.id && (where.status === undefined || runRow.status === where.status);
        if (!match) return { count: 0 };
        Object.assign(runRow, data);
        return { count: 1 };
      },
    },
    codexProject: { async findUnique() { return { id: 'p1', name: 'Demo' }; } },
  };
  const eventStore = { async appendEvent(runId, type, data) { events.push({ runId, type, data }); } };
  const loop = async () => ({ status: 'done' });
  let terminalPublishes = 0;
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma,
    eventStore,
    runAgentLoop: loop,
    clock: () => new Date('2026-06-13T12:00:00Z'),
    triggers: { async publish() { terminalPublishes += 1; return {}; } },
  });
  // The row was cancelled out-of-band; the guarded write must not revert it to done.
  assert.equal(runRow.status, 'cancelled');
  assert.equal(res.raced, true);
  assert.equal(cancelFlips, 1);
  // Only `running` was emitted by the processor; no terminal done/error event.
  const statuses = events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running']);
  assert.equal(terminalPublishes, 0);
});

test('hard timeout aborts a hung loop into error', async () => {
  const d = makeDeps();
  const loop = ({ signal }) => new Promise((resolve) => {
    // never resolves on its own; abort via the timeout signal
    signal.addEventListener('abort', () => resolve({ status: 'done' }), { once: true });
  });
  const res = await processCodexRunJob({
    runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock,
    env: { CODEX_RUN_TIMEOUT_MS: '20' },
  });
  assert.equal(res.status, 'error');
  assert.match(res.error, /timeout/i);
});

test('abortRun reaches the live adapter by runId and finalizes cancellation', async () => {
  const d = makeDeps();
  const processing = processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
    clock: d.clock,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortRun('run-1'), true);
  const res = await processing;
  assert.equal(res.status, 'cancelled');
  assert.equal(d.runRow.status, 'cancelled');
});

test('timeout waits for cooperative adapter drain and ignores its late outcome', async () => {
  const d = makeDeps();
  let drained = false;
  const startedAt = Date.now();
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          drained = true;
          resolve({ status: 'done' });
        }, 25);
      }, { once: true });
    }),
    clock: d.clock,
    env: { CODEX_RUN_TIMEOUT_MS: '10', CODEX_RUN_DRAIN_TIMEOUT_MS: '100' },
  });
  assert.equal(res.status, 'error');
  assert.equal(drained, true);
  assert.ok(Date.now() - startedAt >= 20);
  assert.equal(d.runRow.status, 'error');
});

test('native execution suppresses event effects after abort', async () => {
  const controller = new AbortController();
  let writes = 0;
  const context = executionContextForAdapter({
    adapter: nativeCodexAdapter,
    signal: controller.signal,
    isCancelled: async () => false,
    run: { id: 'run-1', mode: 'build' },
    project: { id: 'p1', name: 'Demo' },
    deps: {
      eventStore: { async appendEvent() { writes += 1; } },
      env: {},
    },
  });
  controller.abort(new Error('timeout'));
  await context.deps.eventStore.appendEvent('run-1', 'late', {});
  assert.equal(writes, 0);
});

test('outer cleanup releases the controller when terminal side effects throw', async () => {
  const d = makeDeps();
  const eventStore = {
    ...d.eventStore,
    async appendEvent(runId, type, data, options) {
      if (type === 'run_status' && data.status === 'done') throw new Error('terminal event failed');
      return d.eventStore.appendEvent(runId, type, data, options);
    },
  };
  await assert.rejects(
    () => processCodexRunJob({
      runId: 'run-1',
      prisma: d.prisma,
      eventStore,
      runAgentLoop: async () => ({ status: 'done' }),
      clock: d.clock,
    }),
    /terminal event failed/,
  );
  assert.equal(abortRun('run-1'), false);
});

test('non-queued run is skipped (idempotency)', async () => {
  const d = makeDeps({ run: { status: 'running' } });
  let loopCalled = false;
  const loop = async () => { loopCalled = true; return { status: 'done' }; };
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop });
  assert.equal(res.skipped, true);
  assert.equal(loopCalled, false);
});

test('missing run returns not_found', async () => {
  const d = makeDeps();
  const res = await processCodexRunJob({ runId: 'nope', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: async () => ({ status: 'done' }) });
  assert.equal(res.status, 'not_found');
});

test('processor executes the selected adapter with the v1 envelope and owned lifecycle context', async () => {
  const d = makeDeps();
  let selectedEnv;
  let received;
  const agentAdapterRegistry = {
    resolveImplementer({ env }) {
      selectedEnv = env;
      return {
        execute(request, context) {
          received = { request, context };
          return { status: 'done' };
        },
      };
    },
  };
  const env = { CODEX_IMPLEMENTER_ADAPTER: 'native', CODEX_RUN_TIMEOUT_MS: '60000', CODEX_MAX_STEPS: '7' };
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    agentAdapterRegistry,
    clock: d.clock,
    env,
  });

  assert.equal(res.status, 'done');
  assert.equal(selectedEnv, env);
  assert.equal(received.request.schemaVersion, 'sira.agent.v1');
  assert.equal(received.request.role, 'implementer');
  assert.equal(received.request.run.id, 'run-1');
  assert.equal(received.request.project.id, 'p1');
  assert.equal(Object.hasOwn(received.request.run, 'userId'), false);
  assert.equal(Object.hasOwn(received.request.project, 'workspacePath'), false);
  assert.deepEqual(received.request.budget, { timeoutMs: 60_000, maxSteps: 7 });
  assert.deepEqual(received.context.deps, {});
  assert.equal(received.context.nativeRun, undefined);
  assert.equal(received.context.nativeProject, undefined);
  assert.equal(typeof received.context.isCancelled, 'function');
  assert.equal(received.context.signal.aborted, false);
});

test('unknown implementer configuration fails the run closed without calling native loop', async () => {
  const d = makeDeps();
  let loopCalled = false;
  const res = await processCodexRunJob({
    runId: 'run-1',
    prisma: d.prisma,
    eventStore: d.eventStore,
    runAgentLoop: async () => { loopCalled = true; return { status: 'done' }; },
    clock: d.clock,
    env: { CODEX_IMPLEMENTER_ADAPTER: 'not-installed' },
  });

  assert.equal(loopCalled, false);
  assert.equal(res.status, 'error');
  assert.match(res.error, /CODEX_IMPLEMENTER_ADAPTER=not-installed is unsupported/);
  assert.deepEqual(
    d.events.filter((event) => event.type === 'run_status').map((event) => event.data.status),
    ['running', 'error'],
  );
});

test('malformed adapter outcomes fail closed as error instead of defaulting to done', async () => {
  for (const malformed of [undefined, null, { status: 'mystery' }]) {
    const d = makeDeps();
    const res = await processCodexRunJob({
      runId: 'run-1',
      prisma: d.prisma,
      eventStore: d.eventStore,
      runAgentLoop: async () => malformed,
      clock: d.clock,
    });
    assert.equal(res.status, 'error');
    assert.match(res.error, /AgentAdapter\.execute\(\)|unsupported outcome status/);
    assert.equal(d.runRow.status, 'error');
  }
});
