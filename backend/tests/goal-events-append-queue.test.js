'use strict';

// goal-events appends: one run emits dozens of concurrent appends
// (goal-worker persists every research-agent event fire-and-forget).
// Prod 2026-09-27 showed bursts of 86 Serializable conflicts per second and
// dropped events. These tests pin the per-run queue: no conflicts, no lost
// events, contiguous seq in emission order, and jittered retries for
// conflicts that still happen across processes.

const test = require('node:test');
const assert = require('node:assert/strict');

const goalEvents = require('../src/services/goal-events');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Fake Prisma that behaves like a Serializable transaction: when two
// transactions for the same goalRunId overlap, the later commit fails with
// P2034 — exactly what Postgres reported in production.
function makeFakePrisma({ failType = null } = {}) {
  const rows = [];
  const active = new Set();
  const stats = { conflicts: 0, transactions: 0 };

  const base = {
    async findFirst({ where }) {
      const seqs = rows.filter((r) => r.goalRunId === where.goalRunId).map((r) => r.seq);
      return seqs.length ? { seq: Math.max(...seqs) } : null;
    },
    async create({ data }) {
      if (data.type === failType) throw new Error('boom: not retryable');
      if (rows.some((r) => r.goalRunId === data.goalRunId && r.seq === data.seq)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      rows.push({ ...data });
      return { id: `e${rows.length}`, ...data };
    },
  };

  return {
    rows,
    stats,
    goalRun: { async updateMany() { return { count: 1 }; } },
    goalRunEvent: base,
    async $transaction(fn) {
      stats.transactions += 1;
      const state = { run: null, overlapped: false };
      active.add(state);
      try {
        const tx = {
          goalRun: this.goalRun,
          goalRunEvent: {
            async findFirst(args) {
              state.run = args.where.goalRunId;
              for (const other of active) {
                if (other !== state && other.run === state.run) {
                  other.overlapped = true;
                  state.overlapped = true;
                }
              }
              await tick();
              return base.findFirst(args);
            },
            async create(args) {
              await tick();
              if (state.overlapped) {
                stats.conflicts += 1;
                throw Object.assign(
                  new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'),
                  { code: 'P2034' },
                );
              }
              return base.create(args);
            },
          },
        };
        return await fn(tx);
      } finally {
        active.delete(state);
      }
    },
  };
}

function withFakePrisma(fake) {
  goalEvents._internal.setPrismaForTests(fake);
  return () => goalEvents._internal.setPrismaForTests(require('../src/config/database'));
}

test('200 concurrent appends to one run: no conflicts, none lost, seq 1..200 in emission order', async () => {
  const fake = makeFakePrisma();
  const restore = withFakePrisma(fake);
  try {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => goalEvents.appendEvent({
        goalRunId: 'run-a',
        type: 'finding',
        payload: { type: 'finding', index: i },
      })),
    );
    assert.equal(results.filter((r) => r.ok).length, 200, 'every append persisted');
    assert.equal(fake.stats.conflicts, 0, 'appends for one run never overlap');
    const persisted = fake.rows.filter((r) => r.goalRunId === 'run-a').sort((a, b) => a.seq - b.seq);
    assert.deepEqual(persisted.map((r) => r.seq), Array.from({ length: 200 }, (_, i) => i + 1));
    assert.deepEqual(persisted.map((r) => r.payload.index), Array.from({ length: 200 }, (_, i) => i),
      'seq order matches emission order');
    assert.equal(goalEvents._internal.appendQueues.size, 0, 'queue entry released after the burst');
  } finally {
    restore();
  }
});

test('different runs still append in parallel and each keeps its own contiguous seq', async () => {
  const fake = makeFakePrisma();
  const restore = withFakePrisma(fake);
  try {
    await Promise.all(['run-x', 'run-y', 'run-z'].flatMap((run) => Array.from({ length: 30 }, (_, i) => (
      goalEvents.appendEvent({ goalRunId: run, type: 'page', payload: { i } })
    ))));
    for (const run of ['run-x', 'run-y', 'run-z']) {
      const seqs = fake.rows.filter((r) => r.goalRunId === run).map((r) => r.seq).sort((a, b) => a - b);
      assert.deepEqual(seqs, Array.from({ length: 30 }, (_, i) => i + 1), `${run} contiguous`);
    }
    assert.equal(fake.stats.conflicts, 0);
  } finally {
    restore();
  }
});

test('a failing append reports ok:false and does not block the next ones', async () => {
  const fake = makeFakePrisma({ failType: 'broken' });
  const restore = withFakePrisma(fake);
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const [first, broken, third] = await Promise.all([
      goalEvents.appendEvent({ goalRunId: 'run-b', type: 'phase', payload: { phase: 'plan' } }),
      goalEvents.appendEvent({ goalRunId: 'run-b', type: 'broken', payload: {} }),
      goalEvents.appendEvent({ goalRunId: 'run-b', type: 'report', payload: {} }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(broken.ok, false);
    assert.equal(third.ok, true, 'the queue keeps going after a failure');
    assert.deepEqual(fake.rows.filter((r) => r.goalRunId === 'run-b').map((r) => r.seq), [1, 2]);
  } finally {
    process.env.NODE_ENV = previousEnv;
    restore();
  }
});

test('cross-process conflicts are retried with backoff until the append lands', async () => {
  let failuresLeft = 2;
  const rows = [];
  const fake = {
    goalRun: { async updateMany() { return { count: 1 }; } },
    goalRunEvent: {},
    async $transaction(fn) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      }
      return fn({
        goalRun: this.goalRun,
        goalRunEvent: {
          async findFirst() { return rows.length ? { seq: rows.length } : null; },
          async create({ data }) { rows.push(data); return { id: 'e1', ...data }; },
        },
      });
    },
  };
  const restore = withFakePrisma(fake);
  try {
    const started = Date.now();
    const result = await goalEvents.appendEvent({ goalRunId: 'run-c', type: 'info', payload: {} });
    assert.equal(result.ok, true);
    assert.equal(result.seq, 1);
    assert.ok(Date.now() - started >= 10, 'retries waited instead of spinning');
  } finally {
    restore();
  }
});

test('retry delays grow with jitter and are capped', () => {
  const { retryDelayMs } = goalEvents._internal;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const base = Math.min(500, 15 * 2 ** attempt);
    const d = retryDelayMs(attempt);
    assert.ok(d >= Math.floor(base * 0.5) && d <= Math.ceil(base * 1.5), `attempt ${attempt}: ${d}ms`);
  }
});

function makeAtomicRollupPrisma(errorCode) {
  let committed = { rows: [], findingsCount: 0, phase: null };
  let failNextUpdate = true;
  function modelFor(state) {
    return {
      goalRunEvent: {
        async findFirst() { return state.rows.at(-1) || null; },
        async create({ data }) {
          const row = { ...data, id: `e${data.seq}` };
          state.rows.push(row);
          return row;
        },
      },
      goalRun: {
        async updateMany({ data }) {
          if (failNextUpdate) {
            failNextUpdate = false;
            throw Object.assign(new Error('rollup persistence failed'), { code: errorCode });
          }
          state.findingsCount += data.findingsCount?.increment || 0;
          if (data.phase) state.phase = data.phase;
          return { count: 1 };
        },
      },
    };
  }
  return {
    get state() { return committed; },
    get goalRunEvent() { return modelFor(committed).goalRunEvent; },
    get goalRun() { return modelFor(committed).goalRun; },
    async $transaction(fn) {
      const pending = { ...committed, rows: [...committed.rows] };
      const result = await fn(modelFor(pending));
      // A real transaction only exposes its event and rollup after both succeed.
      committed = pending;
      return result;
    },
  };
}

test('a retryable rollup conflict cannot commit the same event twice', async () => {
  const fake = makeAtomicRollupPrisma('P2034');
  const restore = withFakePrisma(fake);
  try {
    const result = await goalEvents.appendEvent({ goalRunId: 'run-atomic', type: 'finding', payload: { label: 'one finding' } });
    assert.equal(result.ok, true);
    assert.equal(fake.state.rows.length, 1, 'failed rollup rolls back the event before retry');
    assert.equal(result.seq, 1);
    assert.equal(fake.state.findingsCount, 1);
  } finally { restore(); }
});

test('a permanent rollup failure leaves no half-committed event and the queue continues', async () => {
  const fake = makeAtomicRollupPrisma('P1001');
  const restore = withFakePrisma(fake);
  try {
    const failed = await goalEvents.appendEvent({ goalRunId: 'run-atomic', type: 'finding', payload: {} });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /rollup persistence failed/);
    assert.equal(fake.state.rows.length, 0, 'failed append must not leave an event without its counter');
    assert.equal(fake.state.findingsCount, 0);
    const next = await goalEvents.appendEvent({ goalRunId: 'run-atomic', type: 'phase', payload: { phase: 'search' } });
    assert.equal(next.ok, true);
    assert.equal(next.seq, 1);
    assert.equal(fake.state.rows.length, 1);
    assert.equal(fake.state.phase, 'search');
  } finally { restore(); }
});
