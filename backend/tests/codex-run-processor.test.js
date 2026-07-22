'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { processCodexRunJob } = require('../src/services/codex/run-processor');

// Fake prisma: one run + one project, mutable status.
function makeDeps({ run, project } = {}) {
  const runRow = { id: 'run-1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued', ...run };
  const projRow = { id: 'p1', name: 'Demo', ...project };
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
  };
  const eventStore = {
    async appendEvent(runId, type, data) { events.push({ runId, type, data }); return { runId, type, data, seq: events.length }; },
  };
  const clock = () => new Date('2026-06-13T12:00:00.000Z');
  return { prisma, eventStore, clock, events, runRow };
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
  // Loop returns done, but the row was flipped to cancelled mid-flight.
  const loop = async () => { d.runRow.status = 'cancelled'; return { status: 'done' }; };
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock });
  assert.equal(res.status, 'cancelled');
  // Only the 'running' run_status is emitted here; cancelRun owns 'cancelled'.
  const statuses = d.events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running']);
});

test('cancel landing after the isCancelled() check is not clobbered and emits no terminal run_status', async () => {
  // Simulate cancelRun flipping the row to `cancelled` in the narrow window
  // AFTER the processor's post-loop isCancelled() check but BEFORE its guarded
  // terminal write. The guarded updateMany (where status:'running') must no-op,
  // so the row stays `cancelled` and no duplicate run_status is emitted.
  const runRow = { id: 'run-1', projectId: 'p1', userId: 'u1', mode: 'build', status: 'queued' };
  const events = [];
  let cancelFlips = 0;
  const prisma = {
    codexRun: {
      async findUnique({ where }) {
        if (where.id !== runRow.id) return null;
        // Snapshot BEFORE mutating so the post-loop isCancelled() observes the
        // pre-cancel `running` value (returns false), then cancelRun lands: the
        // row is `cancelled` by the time the guarded terminal write runs.
        const snapshot = { ...runRow };
        if (runRow.status === 'running') {
          cancelFlips += 1;
          runRow.status = 'cancelled'; // flips just AFTER this read returns `running`
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
  const res = await processCodexRunJob({ runId: 'run-1', prisma, eventStore, runAgentLoop: loop, clock: () => new Date('2026-06-13T12:00:00Z') });
  // The row was cancelled out-of-band; the guarded write must not revert it to done.
  assert.equal(runRow.status, 'cancelled');
  assert.equal(res.raced, true);
  // Only `running` was emitted by the processor; no terminal done/error event.
  const statuses = events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
  assert.deepEqual(statuses, ['running']);
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
