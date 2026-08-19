'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { memoize, defaultKey } = require('../src/utils/memoize');

describe('memoize — sync', () => {
  test('caches by argument', () => {
    let calls = 0;
    const fn = memoize((n) => { calls += 1; return n * 2; });
    assert.equal(fn(5), 10);
    assert.equal(fn(5), 10);
    assert.equal(fn(7), 14);
    assert.equal(calls, 2);
  });

  test('different args produce different results', () => {
    const fn = memoize((a, b) => a + b);
    assert.equal(fn(1, 2), 3);
    assert.equal(fn(2, 1), 3);
    assert.equal(fn.cache.size, 2);
  });

  test('rejects non-function', () => {
    assert.throws(() => memoize(null), TypeError);
  });
});

describe('memoize — async + single-flight', () => {
  test('concurrent identical calls collapse', async () => {
    let calls = 0;
    const fn = memoize(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    });
    const [a, b, c] = await Promise.all([fn(), fn(), fn()]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b, c], ['ok', 'ok', 'ok']);
  });

  test('rejected promise NOT cached by default', async () => {
    let calls = 0;
    const fn = memoize(async () => { calls += 1; throw new Error('boom'); });
    await assert.rejects(fn(), /boom/);
    await assert.rejects(fn(), /boom/);
    assert.equal(calls, 2);
  });

  test('cacheRejections caches sync rejections (single call wins)', () => {
    let calls = 0;
    const fn = memoize((n) => { calls += 1; throw new Error(`boom-${n}`); }, { cacheRejections: true });
    try { fn(1); } catch { /* expected */ }
    try { fn(1); } catch { /* expected */ }
    assert.equal(calls, 1);
  });
});

describe('memoize — TTL', () => {
  test('expired entry triggers re-call', () => {
    let t = 0;
    let calls = 0;
    const fn = memoize((n) => { calls += 1; return n; }, { ttlMs: 100, now: () => t });
    fn(1); fn(1);
    assert.equal(calls, 1);
    t = 200;
    fn(1);
    assert.equal(calls, 2);
  });
});

describe('memoize — LRU eviction', () => {
  test('exceeding max evicts oldest', () => {
    const fn = memoize((n) => n, { max: 3 });
    fn(1); fn(2); fn(3); fn(4);
    assert.equal(fn.cache.size, 3);
    // 1 should be gone (eldest after 4 was added).
    assert.equal(fn.cache.has(defaultKey([1])), false);
  });

  test('hit moves entry to MRU position', () => {
    const fn = memoize((n) => n, { max: 3 });
    fn(1); fn(2); fn(3);
    fn(1); // touch 1 → most recent
    fn(4); // evicts 2 (now LRU)
    assert.equal(fn.cache.has(defaultKey([1])), true);
    assert.equal(fn.cache.has(defaultKey([2])), false);
  });
});

describe('memoize — invalidate / clear', () => {
  test('invalidate removes a single entry', () => {
    let calls = 0;
    const fn = memoize((n) => { calls += 1; return n; });
    fn(5); fn(5);
    fn.invalidate(5);
    fn(5);
    assert.equal(calls, 2);
  });
  test('clear empties the whole cache', () => {
    const fn = memoize((n) => n);
    fn(1); fn(2);
    fn.clear();
    assert.equal(fn.cache.size, 0);
  });
});

describe('defaultKey', () => {
  test('zero args → empty string', () => {
    assert.equal(defaultKey([]), '');
  });
  test('primitive single arg', () => {
    assert.equal(defaultKey([42]), 'number:42');
    assert.equal(defaultKey(['x']), 'string:x');
    assert.equal(defaultKey([null]), 'null');
  });
  test('multi-arg or object → JSON', () => {
    assert.equal(defaultKey([{ a: 1 }, 'x']), '[{"a":1},"x"]');
  });
});
