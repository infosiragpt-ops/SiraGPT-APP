'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const eventStore = require('../src/services/codex/event-store');
const pubsub = require('../src/services/codex/redis-pubsub');
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
  let resolvePublished;
  const allPublished = new Promise((resolve) => { resolvePublished = resolve; });
  const publish = async (runId, env) => {
    publishes.push([runId, env]);
    if (publishes.length === 2) resolvePublished();
  };
  const a = await appendEvent('r1', 'run_status', { status: 'running' }, { prisma, publish });
  const b = await appendEvent('r1', 'narrative_delta', { text: 'hola' }, { prisma, publish });
  await allPublished;
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

test('concurrent appends publish in seq order even when the first publish is slow', async () => {
  const prisma = makeFakePrisma();
  const published = [];
  let releaseFirst;
  let firstStarted;
  let resolveSecond;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const secondPublished = new Promise((resolve) => { resolveSecond = resolve; });
  const firstPublishReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const publish = async (_runId, envelope) => {
    published.push(envelope.seq);
    if (envelope.seq === 1) {
      firstStarted();
      await firstPublishReleased;
    }
    if (envelope.seq === 2) resolveSecond();
  };

  const first = appendEvent('r-order', 'narrative_delta', { text: 'one' }, { prisma, publish });
  await firstStartedPromise;
  const second = appendEvent('r-order', 'narrative_delta', { text: 'two' }, { prisma, publish });
  releaseFirst();
  await Promise.all([first, second]);
  await secondPublished;

  assert.deepEqual(published, [1, 2]);
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
  assert.equal(prisma._rows[0].payload.text, 'still saved');
});

test('a publish promise that never settles cannot block appendEvent', async () => {
  const prisma = makeFakePrisma();
  const hungPublish = () => new Promise(() => {});
  const append = appendEvent(
    'r-hung',
    'narrative_delta',
    { text: 'durable before fan-out' },
    {
      prisma,
      publish: hungPublish,
      env: { CODEX_REDIS_PUBLISH_TIMEOUT_MS: '25' },
    },
  );

  const ev = await Promise.race([
    append,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('appendEvent remained blocked')), 250);
      timer.unref?.();
    }),
  ]);

  assert.equal(ev.seq, 1);
  assert.equal(prisma._rows.length, 1);
  assert.equal(prisma._rows[0].payload.text, 'durable before fan-out');
});

test('concurrent durable appends settle without waiting for a hung publisher chain', async () => {
  const prisma = makeFakePrisma();
  const N = 25;
  const startedAt = Date.now();
  const appends = Array.from({ length: N }, (_, i) => appendEvent(
    'r-hung-many',
    'narrative_delta',
    { text: String(i) },
    {
      prisma,
      publish: () => new Promise(() => {}),
      env: { CODEX_REDIS_PUBLISH_TIMEOUT_MS: '25' },
    },
  ));

  await Promise.race([
    Promise.all(appends),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('durable appends remained blocked')), 100);
      timer.unref?.();
    }),
  ]);

  assert.equal(prisma._rows.length, N);
  assert.ok(Date.now() - startedAt < 100, 'durable path must not accumulate publish timeouts');
});

test('publisher connection refuses offline queuing and limits retries', () => {
  const options = pubsub.publisherRedisOptions({
    CODEX_REDIS_PUBLISH_TIMEOUT_MS: '75',
  });

  assert.equal(options.lazyConnect, true);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.connectTimeout, 75);
  assert.equal(options.commandTimeout, 75);
  assert.equal(options.retryStrategy(1), 50);
  assert.equal(options.retryStrategy(2), null);
});

test('publishEvent times out fail-open and rate-limits warnings', async () => {
  const warnings = [];
  const connection = {
    status: 'ready',
    publish: () => new Promise(() => {}),
  };
  const options = {
    connection,
    env: { NODE_ENV: 'production', CODEX_REDIS_PUBLISH_TIMEOUT_MS: '25' },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  };

  assert.equal(await pubsub.publishEvent('r-timeout', { seq: 1 }, options), false);
  assert.equal(await pubsub.publishEvent('r-timeout', { seq: 2 }, options), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /durable replay remains available/);
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

test('listEvents transparently pages the default replay past 5000 events', async () => {
  const prisma = makeFakePrisma();
  for (let seq = 1; seq <= 5001; seq += 1) {
    prisma._rows.push({
      id: `page-${seq}`,
      runId: 'r-pages',
      seq,
      type: seq === 5001 ? 'run_status' : 'narrative_delta',
      payload: seq === 5001 ? { status: 'done' } : { text: String(seq) },
      createdAt: new Date('2026-06-13T00:00:00.000Z'),
    });
  }

  const events = await listEvents('r-pages', { prisma });
  assert.equal(events.length, 5001);
  assert.equal(events[0].seq, 1);
  assert.equal(events.at(-1).seq, 5001);
  assert.equal(events.at(-1).data.status, 'done');

  const explicitUndefined = await listEvents('r-pages', { prisma, limit: undefined });
  assert.equal(explicitUndefined.length, 5001, 'limit: undefined must use paginated default replay');
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
