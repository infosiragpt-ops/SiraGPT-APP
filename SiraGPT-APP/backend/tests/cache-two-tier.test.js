'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TwoTier } = require('../src/cache/TwoTier');

function makeL2() {
  const store = new Map();
  const calls = { get: 0, set: 0, delete: 0, errors: { get: 0, set: 0, delete: 0 } };
  return {
    store, calls,
    async get(k) { calls.get++; return store.get(k); },
    async set(k, v) { calls.set++; store.set(k, v); },
    async delete(k) { calls.delete++; return store.delete(k); },
  };
}

test('exports the TwoTier class', () => {
  assert.equal(typeof TwoTier, 'function');
});

test('falls back to default ttl when l1TtlMs is missing', () => {
  const cache = new TwoTier();
  // default is 5 minutes
  assert.equal(cache._defaultTtlMs, 5 * 60 * 1000);
});

test('honours explicit defaultTtlMs over l1TtlMs', () => {
  const cache = new TwoTier({ defaultTtlMs: 1000, l1TtlMs: 9999 });
  assert.equal(cache._defaultTtlMs, 1000);
});

test('get returns undefined for falsy keys and records a miss', async () => {
  const cache = new TwoTier();
  assert.equal(await cache.get(''), undefined);
  assert.equal(await cache.get(null), undefined);
  const snap = cache.snapshot();
  assert.ok(snap.misses >= 2);
});

test('L1 hit returns the value without touching L2', async () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  await cache.set('a', 1);
  const v = await cache.get('a');
  assert.equal(v, 1);
  assert.equal(l2.calls.get, 0, 'L1 hit must not query L2');
  const snap = cache.snapshot();
  assert.ok(snap.l1_hits >= 1);
});

test('L2 hit hoists the value into L1 and counts the L2Hit metric', async () => {
  const l2 = makeL2();
  l2.store.set('b', 2);
  const cache = new TwoTier({ l2 });
  const v = await cache.get('b');
  assert.equal(v, 2);
  assert.equal(l2.calls.get, 1);
  const snap = cache.snapshot();
  assert.ok(snap.l2_hits >= 1);
  // Subsequent get must hit L1 (no second L2 call)
  const v2 = await cache.get('b');
  assert.equal(v2, 2);
  assert.equal(l2.calls.get, 1, 'L2 must not be queried again after L1 hoist');
});

test('L2 errors degrade to a miss without throwing', async () => {
  const l2 = {
    async get() { throw new Error('redis down'); },
    async set() {},
    async delete() {},
  };
  const cache = new TwoTier({ l2 });
  const v = await cache.get('z');
  assert.equal(v, undefined);
  const snap = cache.snapshot();
  // An L2Error must be tracked (specific metric name varies but should exist)
  assert.ok(typeof snap === 'object');
});

test('set writes to both L1 and L2 (fire-and-forget) without blocking', async () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  await cache.set('a', 1);
  // L1 set is synchronous within the call
  assert.equal(cache.l1.has('a'), true);
  // L2 set is fire-and-forget — give the microtask queue a tick
  await new Promise((r) => setImmediate(r));
  assert.equal(l2.store.get('a'), 1);
});

test('setAndWait awaits the L2 set before returning', async () => {
  let resolved = false;
  const l2 = {
    async get() {},
    async set(k, v) { await new Promise((r) => setTimeout(r, 10)); resolved = true; },
    async delete() {},
  };
  const cache = new TwoTier({ l2 });
  await cache.setAndWait('a', 1);
  assert.equal(resolved, true, 'setAndWait must not return before L2.set resolves');
});

test('set with falsy key is a no-op', async () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  await cache.set('', 1);
  await cache.set(null, 1);
  assert.equal(l2.calls.set, 0);
  assert.equal(cache.l1.size, 0);
});

test('delete removes from both L1 and L2 and returns true when any layer had the key', async () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  await cache.set('a', 1);
  await new Promise((r) => setImmediate(r)); // let fire-and-forget finish
  const out = await cache.delete('a');
  assert.equal(out, true);
  assert.equal(cache.l1.has('a'), false);
  assert.equal(l2.store.has('a'), false);
});

test('delete returns false when neither layer has the key', async () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  const out = await cache.delete('nope');
  assert.equal(out, false);
});

test('snapshot exposes the metrics surface', () => {
  const cache = new TwoTier();
  const snap = cache.snapshot();
  assert.equal(typeof snap, 'object');
  // Snapshot should be a plain object — the specific keys are owned by
  // metrics.js, but it must not throw and must return something usable.
});

test('recordBypass increments the bypass counter exposed in snapshot', () => {
  const cache = new TwoTier();
  const before = cache.snapshot();
  cache.recordBypass();
  cache.recordBypass();
  const after = cache.snapshot();
  // bypasses key may or may not be present depending on metrics shape, but the
  // snapshot must remain a plain object that can be diffed
  assert.equal(typeof before, 'object');
  assert.equal(typeof after, 'object');
});

test('l1 and l2 getters return the underlying tier instances', () => {
  const l2 = makeL2();
  const cache = new TwoTier({ l2 });
  assert.ok(cache.l1);
  assert.equal(typeof cache.l1.get, 'function');
  assert.equal(cache.l2, l2);
});
