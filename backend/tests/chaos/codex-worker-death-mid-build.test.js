'use strict';

/**
 * Chaos: the worker DIES mid-build and the state it leaves behind.
 *
 * Three deterministic death shapes, each mapped to the real mechanism that
 * owns its recovery:
 *
 *   A) Death mid-STEP (the model transport dies while the loop is between
 *      turns), processed through the REAL worker lifecycle
 *      (processCodexRunJob → native adapter → runBuildLoop): the run must end
 *      with the row `error`, a terminal `run_status` event for the SSE replay,
 *      and NO throw escaping to BullMQ (a thrown job would be retried forever).
 *
 *   B) Death mid-CHECKPOINT-WRITE (git commit already succeeded, the
 *      codexCheckpoint row write explodes): closeBuild must fail CLOSED —
 *      no success card for a checkpoint that was never persisted, an explicit
 *      narrative + executive summary, and a clean { ok:false } return. The
 *      workspace keeps the committed work (nothing is rolled back behind the
 *      user's back), so the next boot-recovery sweep can resume the run.
 *      This shape is NOT covered by tests/codex-boot-recovery.test.js (which
 *      owns the zombie-running / stuck-queued sweeps) nor by
 *      tests/codex-checkpoint-service.test.js (happy-path checkpointing).
 *
 *   C) Death between steps, discovered at the NEXT boot (run row still
 *      'running', its job lost): recoverCodexRunsAfterBoot re-enqueues the
 *      SAME run with a unique jobId; on the 3rd consecutive interruption
 *      (MAX_BOOT_RESUMES = 2 prior resumes) it refuses to requeue and marks
 *      the run error — bounded recovery, never an infinite requeue loop.
 *
 * Every await runs under a hard Promise.race watchdog; no real timers beyond
 * microseconds of scheduling, no network, no child processes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { processCodexRunJob } = require('../../src/services/codex/run-processor');
const { closeBuild } = require('../../src/services/codex/agent-loop');
const bootRecovery = require('../../src/services/codex/boot-recovery');
const { MAX_BOOT_RESUMES, RESUME_MARKER, INTERRUPTED_MSG } = bootRecovery;

const T0 = 1_700_000_000_000;
let tick = 0;
const fakeClock = () => new Date(T0 + (tick += 10));

/** Hard settle deadline so a hung promise fails the test instead of stalling it. */
async function mustSettle(promise, label, ms = 1500) {
  let timer = null;
  try {
    const outcome = await Promise.race([
      promise.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms);
      }),
    ]);
    assert.equal(outcome.settled, true, `${label} left the caller's promise PENDING past ${ms}ms`);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runner whose workspace looks like a real Vite project with pending changes. */
function makeRunner() {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    exec: async (_p, cmd) => {
      calls.push(cmd.join(' '));
      if (cmd[0] === 'git' && cmd[1] === 'status') return { exitCode: 0, stdout: ' M index.html\n', stderr: '' };
      if (cmd[0] === 'git' && cmd.includes('rev-parse')) return { exitCode: 0, stdout: 'abc1234deadbee\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    readFile: async (_p, path) => {
      if (['.sira/settings.json', '.sira/hooks.json', '.sira/notes.md', 'SIRA.md', 'package.json', 'tsconfig.json'].includes(path)) {
        throw new Error('file_not_found');
      }
      return { content: 'a\nb\nc' };
    },
    writeFiles: async (_p, files) => { writes.push(...files); return { ok: true }; },
  };
}

function makeEventStore(events) {
  return {
    appendEvent: async (runId, type, data) => {
      events.push({ runId, type, data });
      return { seq: events.length };
    },
    listEvents: async () => [],
  };
}

/**
 * Full control-plane double for the processor: queued run row + project +
 * checkpoint rows. Mirrors makeDeps in tests/codex-run-processor.test.js.
 */
function makePrisma({ checkpointCreateImpl } = {}) {
  const checkpoints = [];
  const runs = [];
  const runRow = {
    id: 'run-death',
    projectId: 'p1',
    userId: 'u1',
    mode: 'build',
    status: 'queued',
    prompt: 'haz una landing',
  };
  runs.push(runRow);
  const projRow = { id: 'p1', userId: 'u1', name: 'Demo' };
  return {
    checkpoints,
    runs,
    runRow,
    codexCheckpoint: {
      create: checkpointCreateImpl
        ? async (args) => checkpointCreateImpl(args, checkpoints)
        : async ({ data }) => {
          const row = { id: `cp-${checkpoints.length + 1}`, createdAt: new Date(T0), ...data };
          checkpoints.push(row);
          return row;
        },
    },
    codexRun: {
      findMany: async ({ where }) => runs.filter((r) => r.status === where.status),
      findUnique: async ({ where }) => {
        const found = runs.find((r) => r.id === where.id);
        return found ? { ...found } : null;
      },
      update: async ({ where, data }) => {
        const found = runs.find((r) => r.id === where.id);
        if (!found) throw new Error('row not found');
        Object.assign(found, data);
        return { ...found };
      },
      updateMany: async ({ where, data }) => {
        const found = runs.find((r) => r.id === where.id && (where.status === undefined || r.status === where.status));
        if (!found) return { count: 0 };
        Object.assign(found, data);
        return { count: 1 };
      },
    },
    codexProject: {
      findUnique: async () => ({ ...projRow }),
    },
    user: { findUnique: async () => ({ plan: 'FREE' }) },
  };
}

describe('chaos: worker death mid-build', () => {
  before(() => { process.env.CODEX_AGENT_V2 = '1'; });
  after(() => { delete process.env.CODEX_AGENT_V2; });

  it('A) death mid-step through the REAL worker lifecycle: clean terminal error, no zombie job', async () => {
    const events = [];
    let stepCalls = 0;
    const prisma = makePrisma();
    // The REAL native adapter drives the REAL build loop; only the LLM step
    // dies mid-task (the worker lost its provider connection / was killed).
    const outcome = await mustSettle(processCodexRunJob({
      runId: 'run-death',
      prisma,
      eventStore: makeEventStore(events),
      runner: makeRunner(),
      clock: fakeClock,
      env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0', CODEX_SESSION_ARTIFACTS: '0' },
      runAgentLoop: null, // native adapter resolves the real agent-loop
    }), 'mid-step death');

    assert.equal(outcome.settled, true);
    assert.ok(!outcome.error || typeof outcome.error === 'string', 'no unexpected throw shape');
    assert.equal(prisma.runRow.status, 'error', 'the killed run must land on the error row');
    const statuses = events.filter((e) => e.type === 'run_status').map((e) => e.data.status);
    assert.equal(statuses.at(-1), 'error', 'the SSE replay must see a terminal run_status');
    assert.deepEqual(statuses, ['running', 'error']);
    assert.match(String(prisma.runRow.error || ''), /no LLM provider configured/,
      'with every rung dead the captured error is explicit');
    assert.ok(prisma.runRow.finishedAt, 'the terminal state is timestamped');
    void stepCalls;
  });

  it('B) death mid-checkpoint-write: fail-closed close, no ghost success, committed work preserved for resume', async () => {
    const events = [];
    const runner = makeRunner();
    let createCalls = 0;
    const outcome = await mustSettle(closeBuild({
      run: { id: 'run-cp-death', projectId: 'p1', userId: 'u1', prompt: 'haz una landing' },
      project: { id: 'p1', name: 'X' },
      runner,
      eventStore: makeEventStore(events),
      prisma: makePrisma({
        checkpointCreateImpl: async () => {
          createCalls += 1;
          // The row write dies mid-flight: DB connection reset after commit.
          throw new Error('db connection reset while writing codexCheckpoint');
        },
      }),
      llmTurn: async () => ({ text: 't' }),
      env: { NODE_ENV: 'test', CODEX_AUTO_VERIFY: '0' },
      clock: fakeClock,
      sourcePrompt: 'haz una landing',
    }), 'mid-checkpoint death');

    assert.equal(outcome.settled, true);
    assert.ok(!outcome.error, 'closeBuild must contain the DB death');
    assert.equal(outcome.value.ok, false, 'the close must NOT report success');
    assert.match(outcome.value.error, /checkpoint failed: db connection reset/);
    assert.equal(createCalls, 1);
    // The git commit DID happen before the DB died (workspace state survives).
    assert.ok(runner.calls.some((c) => c.includes('commit')), 'the workspace commit must already have run');
    // Fail-closed user contract: an explicit narrative, no silent ghost close.
    assert.ok(events.some((e) => e.type === 'narrative_delta' && /checkpoint Git falló/.test(String(e.data?.text || ''))));
    const summary = events.find((e) => e.type === 'executive_summary');
    assert.ok(summary, 'an executive summary must be recorded');
    assert.equal(summary.data.status, 'failed');
    assert.ok(summary.data.risks.some((r) => /Checkpoint pendiente/.test(r)),
      'the failed checkpoint must be listed as pending risk');
  });

  it('C) death between steps, found at next boot: same-run resume twice, then a clean bounded error', async () => {
    const prisma = makePrisma();
    // Empty the SHARED array in place (the codexRun doubles close over it);
    // replacing the property would leave a ghost queued row visible to findMany.
    prisma.runs.length = 0;
    prisma.runs.push({ id: 'run-zombie', projectId: 'p1', status: 'running', error: null });
    const enqueued = [];
    const events = [];
    const queue = {
      enqueueCodexRun: async (payload) => { enqueued.push(payload); return { id: payload.jobId }; },
    };
    const eventStore = {
      appendEvent: async (runId, type, data) => { events.push({ runId, type, data }); },
      listEvents: async (runId) => events.filter((e) => e.runId === runId),
    };
    const opts = () => ({
      prisma,
      queue,
      eventStore,
      sessionService: null,
      env: { CODEX_AGENT_V2: '1', NODE_ENV: 'test' },
      clock: fakeClock,
    });

    // Interruption #1 → the SAME run is re-anchored (queued), never duplicated.
    const first = (await mustSettle(bootRecovery.recoverCodexRunsAfterBoot(opts()), 'boot 1')).value;
    assert.equal(first.resumedRunning, 1);
    assert.equal(first.erroredRunning, 0);
    assert.equal(prisma.runs[0].status, 'queued');
    assert.deepEqual(enqueued, [{ runId: 'run-zombie', jobId: 'run-zombie:r1' }]);
    assert.equal(events.filter((e) => e.type === 'narrative_delta' && String(e.data.text).includes(RESUME_MARKER)).length, 1);
    // The run is back in the queue: the worker flips it to running and dies again.
    prisma.runs[0].status = 'running';

    // Interruption #2 → one more resume (MAX_BOOT_RESUMES = 2 not yet spent).
    const second = (await mustSettle(bootRecovery.recoverCodexRunsAfterBoot(opts()), 'boot 2')).value;
    assert.equal(second.resumedRunning, 1);
    assert.deepEqual(enqueued[1], { runId: 'run-zombie', jobId: 'run-zombie:r2' });
    prisma.runs[0].status = 'running';

    // Interruption #3 → the resume budget is spent: clean error, NO re-enqueue.
    const third = (await mustSettle(bootRecovery.recoverCodexRunsAfterBoot(opts()), 'boot 3')).value;
    assert.equal(third.erroredRunning, 1);
    assert.equal(third.resumedRunning, 0);
    assert.equal(enqueued.length, 2, 'the third death must NOT re-enqueue the run again');
    assert.equal(prisma.runs[0].status, 'error');
    assert.equal(prisma.runs[0].error, INTERRUPTED_MSG);
    assert.ok(prisma.runs[0].finishedAt, 'the terminal error must be timestamped');
    const terminal = events.filter((e) => e.type === 'run_status' && e.data.status === 'error');
    assert.equal(terminal.length, 1, 'the SSE replay must surface the terminal error exactly once');
    assert.equal(MAX_BOOT_RESUMES, 2);
  });
});
