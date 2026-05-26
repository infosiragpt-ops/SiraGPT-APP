'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createLruCache } = require('../src/utils/lru-cache');

describe('createLruCache — basic get/set', () => {
  test('set then get returns value', () => {
    const c = createLruCache({});
    c.set('k', 'v');
    assert.equal(c.get('k'), 'v');
  });

  test('miss returns undefined and counts miss', () => {
    const c = createLruCache({});
    assert.equal(c.get('nope'), undefined);
    assert.equal(c.snapshot().misses, 1);
  });

  test('hit increments hits', () => {
    const c = createLruCache({});
    c.set('k', 'v');
    c.get('k'); c.get('k');
    assert.equal(c.snapshot().hits, 2);
  });

  test('del removes the entry', () => {
    const c = createLruCache({});
    c.set('k', 'v');
    assert.equal(c.del('k'), true);
    assert.equal(c.get('k'), undefined);
  });

  test('clear empties the cache', () => {
    const c = createLruCache({});
    c.set('a', 1); c.set('b', 2);
    c.clear();
    assert.equal(c.size(), 0);
  });
});

describe('createLruCache — LRU eviction', () => {
  test('exceeding max evicts the oldest', () => {
    const c = createLruCache({ max: 3 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('d', 4);
    assert.equal(c.has('a'), false);
    assert.equal(c.has('d'), true);
    assert.equal(c.snapshot().evictions, 1);
  });

  test('get promotes the entry to MRU', () => {
    const c = createLruCache({ max: 3 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.get('a'); // promote a
    c.set('d', 4); // should evict b (now LRU)
    assert.equal(c.has('a'), true);
    assert.equal(c.has('b'), false);
  });

  test('peek does NOT promote', () => {
    const c = createLruCache({ max: 3 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.peek('a');
    c.set('d', 4); // a should still be evicted
    assert.equal(c.has('a'), false);
  });
});

describe('createLruCache — TTL', () => {
  test('default TTL expires entries on get', () => {
    let t = 0;
    const c = createLruCache({ ttlMs: 100, now: () => t });
    c.set('k', 'v');
    t = 50;
    assert.equal(c.get('k'), 'v');
    t = 200;
    assert.equal(c.get('k'), undefined);
  });

  test('per-entry TTL overrides default', () => {
    let t = 0;
    const c = createLruCache({ ttlMs: 1000, now: () => t });
    c.set('short', 'v', 100);
    t = 200;
    assert.equal(c.get('short'), undefined);
  });

  test('expired entry is treated as miss for stats', () => {
    let t = 0;
    const c = createLruCache({ ttlMs: 100, now: () => t });
    c.set('k', 'v');
    t = 200;
    c.get('k');
    assert.equal(c.snapshot().misses, 1);
  });

  test('peek also drops expired entries', () => {
    let t = 0;
    const c = createLruCache({ ttlMs: 100, now: () => t });
    c.set('k', 'v');
    t = 200;
    assert.equal(c.peek('k'), undefined);
  });
});

describe('createLruCache — entries iterator', () => {
  test('yields MRU-first', () => {
    const c = createLruCache({});
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    c.get('a'); // promote a → MRU
    const order = [...c.entries()].map(([k]) => k);
    assert.deepEqual(order, ['a', 'c', 'b']);
  });

  test('skips expired entries', () => {
    let t = 0;
    const c = createLruCache({ ttlMs: 100, now: () => t });
    c.set('a', 1); c.set('b', 2);
    t = 200;
    c.set('c', 3);
    const keys = [...c.entries()].map(([k]) => k);
    assert.deepEqual(keys, ['c']);
  });
});

describe('createLruCache — snapshot', () => {
  test('exposes size/max/ttl/hits/misses/evictions', () => {
    const c = createLruCache({ max: 5, ttlMs: 1000 });
    c.set('a', 1);
    c.get('a'); c.get('miss');
    const s = c.snapshot();
    assert.equal(s.size, 1);
    assert.equal(s.max, 5);
    assert.equal(s.ttlMs, 1000);
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.evictions, 0);
  });
});
