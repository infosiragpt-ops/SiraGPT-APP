'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWriteBehindCache,
  mergeData,
  stableStringify,
  keyFor,
  toPrismaData,
} = require('../src/services/write-behind-cache');

function fakePrisma() {
  const calls = [];
  const user = {
    update: async ({ where, data }) => { calls.push({ model: 'user', where, data }); return { id: where.id, ...data }; },
  };
  const broken = {
    update: async () => { const e = new Error('not found'); e.code = 'P2025'; throw e; },
  };
  return { user, broken, _calls: calls };
}

test('stableStringify is order-insensitive', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify([1, 2]), '[1,2]');
});

test('keyFor produces deterministic keys', () => {
  assert.equal(keyFor('user', { id: 'a' }), keyFor('user', { id: 'a' }));
  assert.notEqual(keyFor('user', { id: 'a' }), keyFor('user', { id: 'b' }));
});

test('mergeData overwrites scalars and accumulates increments', () => {
  const merged = mergeData(
    { a: 1, b: { __increment: 2 } },
    { a: 9, b: { __increment: 3 }, c: 'new' },
  );
  assert.equal(merged.a, 9);
  assert.deepEqual(merged.b, { __increment: 5 });
  assert.equal(merged.c, 'new');
});

test('toPrismaData converts increment markers', () => {
  assert.deepEqual(
    toPrismaData({ name: 'x', count: { __increment: 3 } }),
    { name: 'x', count: { increment: 3 } },
  );
});

test('queueWrite coalesces by (model, where) and last-write-wins', () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 100 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 200 });
  wbc.queueWrite('user', { id: 'b' }, { lastActiveAt: 50 });
  assert.equal(wbc.size(), 2);
  assert.deepEqual(wbc.getPending('user', { id: 'a' }), { lastActiveAt: 200 });
});

test('flushNow batches per model and calls prisma.update', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: 'b' }, { apiUsage: { __increment: 1 } });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 2);
  assert.equal(prisma._calls.length, 2);
  // Verify increment translation
  const incCall = prisma._calls.find((c) => c.where.id === 'b');
  assert.deepEqual(incCall.data.apiUsage, { increment: 1 });
});

test('flushNow tolerates P2025 (row not found) without throwing', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('broken', { id: 'x' }, { foo: 1 });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 0);
});

test('threshold triggers an async flush', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0, flushThreshold: 3 });
  wbc.queueWrite('user', { id: '1' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: '2' }, { lastActiveAt: 1 });
  wbc.queueWrite('user', { id: '3' }, { lastActiveAt: 1 });
  // Give the microtask + flush a chance to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(prisma._calls.length >= 1);
});

test('shutdown drains pending and stops timer', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 5000 });
  wbc.queueWrite('user', { id: 'z' }, { lastActiveAt: 99 });
  const r = await wbc.shutdown();
  assert.equal(r.flushed, 1);
  assert.equal(wbc.size(), 0);
});

test('unknown model is skipped silently', async () => {
  const prisma = fakePrisma();
  const wbc = createWriteBehindCache({ prisma, flushIntervalMs: 0 });
  wbc.queueWrite('nope', { id: 'a' }, { foo: 1 });
  const r = await wbc.flushNow();
  assert.equal(r.flushed, 0);
  const stats = wbc.stats();
  assert.equal(stats.totalDropped, 1);
});

test('redis mirror is fire-and-forget', async () => {
  const prisma = fakePrisma();
  const redisCalls = [];
  const redis = {
    hset: async (...args) => { redisCalls.push(['hset', args]); },
    hdel: async (...args) => { redisCalls.push(['hdel', args]); },
    hgetall: async () => ({}),
  };
  const wbc = createWriteBehindCache({ prisma, redis, flushIntervalMs: 0 });
  wbc.queueWrite('user', { id: 'a' }, { lastActiveAt: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(redisCalls.some((c) => c[0] === 'hset'));
  await wbc.flushNow();
});
