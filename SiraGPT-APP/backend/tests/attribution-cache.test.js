'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/services/attribution-cache');

test.beforeEach(() => cache.__resetForTests());

test('get returns null on miss', () => {
  assert.strictEqual(cache.get({ a: 1 }), null);
});

test('set + get returns the cached value', () => {
  cache.set({ q: 'foo' }, { result: 42 });
  assert.deepStrictEqual(cache.get({ q: 'foo' }), { result: 42 });
});

test('keys are order-independent', () => {
  cache.set({ a: 1, b: 2 }, 'value');
  assert.strictEqual(cache.get({ b: 2, a: 1 }), 'value');
});

test('keys differ when content differs', () => {
  cache.set({ q: 'foo' }, 1);
  assert.strictEqual(cache.get({ q: 'foo!' }), null);
});

test('getOrCompute caches sync values', () => {
  let calls = 0;
  const compute = () => { calls += 1; return { v: 'sync' }; };
  cache.getOrCompute({ k: 1 }, compute);
  cache.getOrCompute({ k: 1 }, compute);
  assert.strictEqual(calls, 1);
});

test('getOrCompute caches async values', async () => {
  let calls = 0;
  const compute = async () => { calls += 1; await Promise.resolve(); return { v: 'async' }; };
  await cache.getOrCompute({ k: 'a' }, compute);
  await cache.getOrCompute({ k: 'a' }, compute);
  assert.strictEqual(calls, 1);
});

test('invalidate removes the specific key', () => {
  cache.set({ q: 'a' }, 1);
  cache.set({ q: 'b' }, 2);
  cache.invalidate({ q: 'a' });
  assert.strictEqual(cache.get({ q: 'a' }), null);
  assert.strictEqual(cache.get({ q: 'b' }), 2);
});

test('clear empties cache + telemetry', () => {
  cache.set({ x: 1 }, 'v');
  cache.get({ x: 1 });
  cache.clear();
  const s = cache.stats();
  assert.strictEqual(s.size, 0);
  assert.strictEqual(s.hits, 0);
});

test('stats reports hit/miss rate', () => {
  cache.get({ q: 'a' });
  cache.set({ q: 'a' }, 1);
  cache.get({ q: 'a' });
  cache.get({ q: 'a' });
  const s = cache.stats();
  assert.strictEqual(s.hits, 2);
  assert.strictEqual(s.misses, 1);
  assert.ok(s.hitRate > 0.6 && s.hitRate <= 1);
});

test('LRU eviction at MAX_ENTRIES', () => {
  for (let i = 0; i < cache.MAX_ENTRIES + 5; i += 1) cache.set({ i }, i);
  const s = cache.stats();
  assert.ok(s.size <= cache.MAX_ENTRIES);
  assert.ok(s.evictions >= 5);
});

test('memoize wraps fn and caches by extracted key', () => {
  let calls = 0;
  const slow = (x) => { calls += 1; return x * 2; };
  const wrapped = cache.memoize(slow);
  assert.strictEqual(wrapped(5), 10);
  assert.strictEqual(wrapped(5), 10);
  assert.strictEqual(calls, 1);
  assert.strictEqual(wrapped(6), 12);
  assert.strictEqual(calls, 2);
});

test('hashKey is deterministic for canonically-equal inputs', () => {
  assert.strictEqual(
    cache.hashKey({ a: 1, b: [2, 3], c: { x: 'y' } }),
    cache.hashKey({ c: { x: 'y' }, b: [2, 3], a: 1 }),
  );
});

test('hashKey differs across different inputs', () => {
  assert.notStrictEqual(cache.hashKey({ a: 1 }), cache.hashKey({ a: 2 }));
});

test('canonicalize handles primitives + null', () => {
  assert.strictEqual(cache.canonicalize(null), null);
  assert.strictEqual(cache.canonicalize(undefined), null);
  assert.strictEqual(cache.canonicalize(42), 42);
  assert.strictEqual(cache.canonicalize('s'), 's');
});

test('hot path: 1000 ops < 500ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) { cache.set({ i }, { v: i }); cache.get({ i }); }
  assert.ok(Date.now() - t0 < 500);
});
