'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const eventStore = require('../src/services/codex/event-store');
const { appendEvent, listEvents, createSeqGate, _resetSeqCache } = eventStore;

// In-memory fake of the Prisma codexEvent model with the real unique
// (runId, seq) constraint enforced so collision-retry is exercised.
function makeFakePrisma() {
  const rows = [];
  let id = 0;
  return {
    _rows: rows,
    codexEvent: {
      async aggregate({ where, _max }) {
        const mine = rows.filter((r) => r.runId === where.runId);
        const max = mine.length ? Math.max(...mine.map((r) => r.seq)) : null;
        return { _max: { seq: _max?.seq ? max : null } };
      },
      async create({ data }) {
        if (rows.some((r) => r.runId === data.runId && r.seq === data.seq)) {
          const err = new Error('Unique constraint failed on the fields: (`runId`,`seq`)');
          err.code = 'P2002';
          throw err;
        }
        const row = { id: `e${++id}`, createdAt: new Date('2026-06-13T00:00:00.000Z'), ...data };
        rows.push(row);
        return row;
      },
      async findMany({ where, orderBy, take }) {
        let out = rows.filter((r) => r.runId === where.runId);
        if (where.seq && where.seq.gt !== undefined) out = out.filter((r) => r.seq > where.seq.gt);
        out.sort((a, b) => (orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return out.slice(0, take);
      },
    },
  };
}

beforeEach(() => _resetSeqCache());

test('appendEvent assigns monotonic seqs starting at 1', async () => {
  const prisma = makeFakePrisma();
  const publishes = [];
  const publish = async (runId, env) => { publishes.push([runId, env]); };
  const a = await appendEvent('r1', 'run_status', { status: 'running' }, { prisma, publish });
  const b = await appendEvent('r1', 'narrative_delta', { text: 'hola' }, { prisma, publish });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(publishes.length, 2);
  assert.equal(publishes[0][0], 'r1');
  assert.equal(publishes[0][1].type, 'run_status');
});

test('appendEvent rejects unknown and invalid events', async () => {
  const prisma = makeFakePrisma();
  await assert.rejects(() => appendEvent('r1', 'bogus', {}, { prisma }), /not persistable/);
  await assert.rejects(() => appendEvent('r1', 'heartbeat', {}, { prisma }), /not persistable/);
  await assert.rejects(() => appendEvent('r1', 'run_status', { status: 'banana' }, { prisma }), /invalid payload/);
});

test('concurrent appends produce 1..N with no gaps or duplicates', async () => {
  const prisma = makeFakePrisma();
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      appendEvent('rC', 'narrative_delta', { text: `t${i}` }, { prisma, publish: async () => {} }),
    ),
  );
  const seqs = prisma._rows.filter((r) => r.runId === 'rC').map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
});

test('seq counter recovers from a unique collision via retry', async () => {
  const prisma = makeFakePrisma();
  // Prime the in-memory counter to next=2 with one normal append.
  const first = await appendEvent('r2', 'run_status', { status: 'queued' }, { prisma, publish: async () => {} });
  assert.equal(first.seq, 1);
  // Out-of-band insert that claims seq 2 — the cached next is now stale.
  await prisma.codexEvent.create({ data: { runId: 'r2', seq: 2, type: 'run_status', payload: { status: 'running' } } });
  // This append tries seq 2 → P2002 → re-sync (MAX=2) → lands on seq 3.
  const ev = await appendEvent('r2', 'narrative_delta', { text: 'recovered' }, { prisma, publish: async () => {} });
  assert.equal(ev.seq, 3);
  const seqs = prisma._rows.filter((r) => r.runId === 'r2').map((r) => r.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('Redis-down publish failure does not break the durable append', async () => {
  const prisma = makeFakePrisma();
  const publish = async () => { throw new Error('redis down'); };
  const ev = await appendEvent('r3', 'narrative_delta', { text: 'still saved' }, { prisma, publish });
  assert.equal(ev.seq, 1);
  assert.equal(prisma._rows.length, 1); // persisted despite publish throwing
});

test('listEvents returns events after a seq in ascending order', async () => {
  const prisma = makeFakePrisma();
  for (let i = 0; i < 5; i++) {
    await appendEvent('r4', 'narrative_delta', { text: `t${i}` }, { prisma, publish: async () => {} });
  }
  const all = await listEvents('r4', { afterSeq: 0, prisma });
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5]);
  const after = await listEvents('r4', { afterSeq: 3, prisma });
  assert.deepEqual(after.map((e) => e.seq), [4, 5]);
  assert.equal(after[0].type, 'narrative_delta');
  assert.equal(after[0].data.text, 't3'); // seq 4 = 4th append (i=3)
});

test('listEvents: an explicit limit of 0 clamps to 1, not the 5000 default', async () => {
  const prisma = makeFakePrisma();
  for (let i = 0; i < 3; i++) {
    await appendEvent('r5', 'narrative_delta', { text: `t${i}` }, { prisma, publish: async () => {} });
  }
  // `Number(0) || 5000` used to balloon limit:0 into 5000 → all 3 returned.
  const rows = await listEvents('r5', { afterSeq: 0, limit: 0, prisma });
  assert.equal(rows.length, 1, 'limit 0 must not be treated as the 5000 default');
});

test('createSeqGate emits each seq exactly once; heartbeats always pass', () => {
  const gate = createSeqGate();
  assert.equal(gate.shouldEmit(1), true);
  assert.equal(gate.shouldEmit(2), true);
  assert.equal(gate.shouldEmit(1), false); // duplicate
  assert.equal(gate.shouldEmit(2), false);
  assert.equal(gate.shouldEmit(3), true);
  assert.equal(gate.shouldEmit(undefined), true); // heartbeat-like
  assert.equal(gate.seenCount(), 3);
});
