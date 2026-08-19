'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TwoTier } = require('../../src/cache/TwoTier');
const { MemoryLRU } = require('../../src/cache/MemoryLRU');
const { RedisStore } = require('../../src/cache/RedisStore');

function fakeRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); return 'OK'; },
    async del(k) { return store.delete(k) ? 1 : 0; },
  };
}

function newTwoTier({ withL2 = true } = {}) {
  const l1 = new MemoryLRU({ maxEntries: 4, ttlMs: 60_000 });
  const l2 = withL2 ? new RedisStore({ redis: fakeRedis(), prefix: 't:' }) : null;
  return new TwoTier({ l1, l2, defaultTtlMs: 60_000 });
}

test('TwoTier returns L1 hit without touching L2', async () => {
  const tt = newTwoTier();
  await tt.setAndWait('k', { a: 1 });
  // Mutate L2 underneath to prove L1 short-circuits
  await tt.l2._redis.set('t:k', JSON.stringify({ a: 999 }));
  const v = await tt.get('k');
  assert.deepEqual(v, { a: 1 });
  assert.equal(tt.metrics.l1Hits, 1);
  assert.equal(tt.metrics.l2Hits, 0);
});

test('TwoTier promotes L2 hits into L1', async () => {
  const tt = newTwoTier();
  // Seed L2 directly, bypassing L1
  await tt.l2.set('warm', { v: 'l2-only' });
  const first = await tt.get('warm');
  assert.deepEqual(first, { v: 'l2-only' });
  assert.equal(tt.metrics.l2Hits, 1);
  // Subsequent get should now be L1
  const second = await tt.get('warm');
  assert.deepEqual(second, { v: 'l2-only' });
  assert.equal(tt.metrics.l1Hits, 1);
});

test('TwoTier records misses', async () => {
  const tt = newTwoTier();
  const v = await tt.get('nope');
  assert.equal(v, undefined);
  assert.equal(tt.metrics.misses, 1);
});

test('TwoTier records L1 evictions through onEvict bridge', async () => {
  const tt = new TwoTier({ l1MaxEntries: 2, l1TtlMs: 60_000 });
  await tt.setAndWait('a', 1);
  await tt.setAndWait('b', 2);
  await tt.setAndWait('c', 3); // evicts a
  assert.equal(tt.metrics.l1Evictions, 1);
});

test('TwoTier survives L2 errors and counts them', async () => {
  const broken = {
    async get() { throw new Error('boom'); },
    async set() { throw new Error('boom'); },
    async del() { throw new Error('boom'); },
  };
  const errs = [];
  const l2 = new RedisStore({ redis: broken, prefix: 't:', onError: (op, e) => errs.push(op) });
  const tt = new TwoTier({ l2, l1MaxEntries: 4, l1TtlMs: 60_000 });
  const v = await tt.get('x');
  assert.equal(v, undefined);
  // RedisStore swallows the error and returns undefined; TwoTier counts a miss.
  assert.equal(tt.metrics.misses, 1);
  assert.ok(errs.length >= 1);
});

test('TwoTier set writes to L1 immediately and L2 fire-and-forget', async () => {
  const tt = newTwoTier();
  tt.set('k', 42, 5000);
  // L1 is sync
  assert.equal(tt.l1.get('k'), 42);
  // Wait a tick for L2
  await new Promise((r) => setImmediate(r));
  assert.equal(tt.l2._redis.store.has('t:k'), true);
});

test('TwoTier records lookup latency samples', async () => {
  const tt = newTwoTier();
  await tt.setAndWait('a', 1);
  await tt.get('a');
  await tt.get('miss');
  const snap = tt.snapshot();
  assert.ok(snap.lookup_samples >= 2);
  assert.ok(snap.lookup_p50_us >= 0);
  assert.ok(snap.lookup_p95_us >= 0);
});

test('TwoTier hit_ratio computes correctly', async () => {
  const tt = newTwoTier();
  await tt.setAndWait('a', 1);
  await tt.get('a');     // hit
  await tt.get('a');     // hit
  await tt.get('miss');  // miss
  assert.equal(tt.snapshot().hit_ratio, 2 / 3);
});

test('TwoTier delete clears both layers', async () => {
  const tt = newTwoTier();
  await tt.setAndWait('a', 1);
  assert.equal(await tt.delete('a'), true);
  assert.equal(tt.l1.get('a'), undefined);
  assert.equal(await tt.l2.get('a'), undefined);
});
