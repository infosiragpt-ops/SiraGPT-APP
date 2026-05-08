'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryLRU } = require('../../src/cache/MemoryLRU');

test('MemoryLRU stores and retrieves values', () => {
  const lru = new MemoryLRU({ maxEntries: 3, ttlMs: 60_000 });
  lru.set('a', 1);
  lru.set('b', 2);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('b'), 2);
  assert.equal(lru.get('missing'), undefined);
});

test('MemoryLRU evicts least-recently-used and reports via onEvict', () => {
  const evicted = [];
  const lru = new MemoryLRU({
    maxEntries: 2,
    ttlMs: 60_000,
    onEvict: (k, v, reason) => evicted.push({ k, v, reason }),
  });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.get('a'); // touch a → b is LRU now
  lru.set('c', 3); // should evict 'b'
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('c'), 3);
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].k, 'b');
  assert.equal(evicted[0].reason, 'capacity');
});

test('MemoryLRU expires entries after TTL', () => {
  let now = 1_000_000;
  const lru = new MemoryLRU({ maxEntries: 5, ttlMs: 1000, now: () => now });
  lru.set('a', 1);
  assert.equal(lru.get('a'), 1);
  now += 1500;
  assert.equal(lru.get('a'), undefined);
  assert.equal(lru.has('a'), false);
});

test('MemoryLRU per-call ttl overrides default', () => {
  let now = 0;
  const lru = new MemoryLRU({ maxEntries: 5, ttlMs: 1000, now: () => now });
  lru.set('short', 1, 100);
  lru.set('long', 2, 10_000);
  now = 200;
  assert.equal(lru.get('short'), undefined);
  assert.equal(lru.get('long'), 2);
});

test('MemoryLRU rejects invalid construction', () => {
  assert.throws(() => new MemoryLRU({ maxEntries: 0 }), TypeError);
  assert.throws(() => new MemoryLRU({ maxEntries: -1 }), TypeError);
  assert.throws(() => new MemoryLRU({ ttlMs: -1 }), TypeError);
});

test('MemoryLRU updating existing key does not evict', () => {
  const lru = new MemoryLRU({ maxEntries: 2, ttlMs: 60_000 });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('a', 99); // update, not insert
  assert.equal(lru.get('a'), 99);
  assert.equal(lru.get('b'), 2);
  assert.equal(lru.size, 2);
});

test('MemoryLRU purgeExpired drops stale entries', () => {
  let now = 0;
  const evicted = [];
  const lru = new MemoryLRU({
    maxEntries: 10, ttlMs: 100, now: () => now,
    onEvict: (k, _v, r) => evicted.push({ k, r }),
  });
  lru.set('a', 1);
  lru.set('b', 2);
  now = 200;
  lru.set('c', 3); // fresh
  const purged = lru.purgeExpired();
  assert.equal(purged, 2);
  assert.equal(lru.get('c'), 3);
  assert.deepEqual(evicted.map((e) => e.r), ['ttl', 'ttl']);
});
