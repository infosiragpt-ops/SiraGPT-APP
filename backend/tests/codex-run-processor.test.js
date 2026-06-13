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
  const loop = async () => ({ status: 'done' });
  const res = await processCodexRunJob({ runId: 'run-1', prisma: d.prisma, eventStore: d.eventStore, runAgentLoop: loop, clock: d.clock });
  assert.equal(res.status, 'done');
  assert.equal(d.runRow.status, 'done');
  assert.ok(d.runRow.startedAt && d.runRow.finishedAt);
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
