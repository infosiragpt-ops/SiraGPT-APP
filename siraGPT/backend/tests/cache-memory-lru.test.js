'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryLRU, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, SUPPORTED_POLICIES } = require('../src/cache/MemoryLRU');

test('exports the documented surface + constants', () => {
  assert.equal(typeof MemoryLRU, 'function');
  assert.equal(typeof DEFAULT_MAX_ENTRIES, 'number');
  assert.equal(typeof DEFAULT_TTL_MS, 'number');
  assert.ok(SUPPORTED_POLICIES instanceof Set);
  assert.ok(SUPPORTED_POLICIES.has('lru'));
  assert.ok(SUPPORTED_POLICIES.has('lfu'));
});

test('constructor rejects invalid maxEntries / ttlMs / policy', () => {
  assert.throws(() => new MemoryLRU({ maxEntries: 0 }), TypeError);
  assert.throws(() => new MemoryLRU({ maxEntries: -1 }), TypeError);
  assert.throws(() => new MemoryLRU({ maxEntries: NaN }), TypeError);
  assert.throws(() => new MemoryLRU({ ttlMs: -1 }), TypeError);
  assert.throws(() => new MemoryLRU({ policy: 'fifo' }), TypeError);
});

test('set/get round-trips a value and counts the hit', () => {
  const cache = new MemoryLRU();
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);
});

test('get returns undefined for a missing key and counts the miss', () => {
  const cache = new MemoryLRU();
  assert.equal(cache.get('nope'), undefined);
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.stats().hits, 0);
});

test('has reflects current presence without bumping hit counter', () => {
  const cache = new MemoryLRU();
  assert.equal(cache.has('x'), false);
  cache.set('x', 1);
  assert.equal(cache.has('x'), true);
  assert.equal(cache.stats().hits, 0);
});

test('expired entries are evicted on get and counted as misses', () => {
  let now = 1_000;
  const cache = new MemoryLRU({ ttlMs: 100, now: () => now });
  cache.set('a', 1);
  now = 2_000;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.stats().misses, 1);
});

test('per-entry ttlMs override beats the default ttl', () => {
  let now = 1_000;
  const cache = new MemoryLRU({ ttlMs: 100, now: () => now });
  cache.set('a', 1, 10_000); // long TTL override
  now = 5_000;
  assert.equal(cache.get('a'), 1);
});

test('ttlMs of 0 on set falls back to the default ttl (not sticky)', () => {
  // The `ttlMs > 0` guard in set() rejects 0 (and negatives), so a caller
  // passing 0 silently inherits the constructor's default ttl rather than
  // creating a sticky entry. The Infinity branch is only reachable when
  // the constructor's ttlMs is 0.
  let now = 1_000;
  const cache = new MemoryLRU({ ttlMs: 100, now: () => now });
  cache.set('a', 1, 0);
  now = 5_000; // past the default 100ms
  assert.equal(cache.get('a'), undefined, 'falls back to default ttl, then expires');
});

test('constructor ttlMs of 0 makes every entry sticky', () => {
  let now = 1_000;
  const cache = new MemoryLRU({ ttlMs: 0, now: () => now });
  cache.set('a', 1);
  now = 9_999_999;
  assert.equal(cache.get('a'), 1, 'ttlMs=0 → Infinity expiry');
});

test('LRU policy evicts the least-recently-used entry on overflow', () => {
  const cache = new MemoryLRU({ maxEntries: 3, ttlMs: 60_000 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); // a is most-recently-used now
  cache.set('d', 4); // should evict 'b' (oldest unused)
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false, 'LRU victim must be evicted');
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
});

test('LFU policy evicts the least-frequently-used entry on overflow', () => {
  const cache = new MemoryLRU({ maxEntries: 3, ttlMs: 60_000, policy: 'lfu' });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.get('a'); cache.get('a'); cache.get('a'); // a: freq=3
  cache.get('b'); // b: freq=1
  // c: freq=0
  cache.set('d', 4); // should evict 'c' (lowest freq)
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), false, 'LFU victim must be the zero-freq entry');
  assert.equal(cache.has('d'), true);
});

test('LFU re-set carries the previous frequency counter', () => {
  const cache = new MemoryLRU({ maxEntries: 2, ttlMs: 60_000, policy: 'lfu' });
  cache.set('a', 1);
  cache.get('a'); cache.get('a'); cache.get('a'); // freq=3
  cache.set('a', 99); // re-set keeps the carried freq
  cache.set('b', 2); // freq=0
  // Now overflow with c — 'b' should be the victim (freq 0 < a's carried 3)
  cache.set('c', 3);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
});

test('onEvict fires with reason "capacity" when the cache evicts to make room', () => {
  const evictions = [];
  const cache = new MemoryLRU({
    maxEntries: 2,
    ttlMs: 60_000,
    onEvict: (k, v, reason) => evictions.push({ k, v, reason }),
  });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3); // evicts 'a'
  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].k, 'a');
  assert.equal(evictions[0].v, 1);
  assert.equal(evictions[0].reason, 'capacity');
});

test('onEvict fires with reason "ttl" during purgeExpired', () => {
  let now = 1_000;
  const evictions = [];
  const cache = new MemoryLRU({
    maxEntries: 10, ttlMs: 100, now: () => now,
    onEvict: (k, v, reason) => evictions.push({ k, v, reason }),
  });
  cache.set('a', 1);
  cache.set('b', 2);
  now = 5_000;
  const purged = cache.purgeExpired();
  assert.equal(purged, 2);
  assert.deepEqual(evictions.map((e) => e.reason), ['ttl', 'ttl']);
});

test('delete removes the key and clear empties the cache', () => {
  const cache = new MemoryLRU();
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.has('a'), false);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('stats reports hitRatio derived from cumulative hits + misses', () => {
  const cache = new MemoryLRU();
  cache.set('a', 1);
  cache.get('a'); cache.get('a'); // 2 hits
  cache.get('nope'); cache.get('nope'); // 2 misses
  const s = cache.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 2);
  assert.equal(s.hitRatio, 0.5);
});

test('resetStats zeroes hits + misses but preserves cache contents', () => {
  const cache = new MemoryLRU();
  cache.set('a', 1);
  cache.get('a');
  cache.get('nope');
  cache.resetStats();
  const s = cache.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.size, 1, 'data must survive resetStats');
});

test('size getter reflects current entry count', () => {
  const cache = new MemoryLRU();
  assert.equal(cache.size, 0);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.size, 2);
});

test('onEvict callback errors do not crash the cache', () => {
  const cache = new MemoryLRU({
    maxEntries: 1, ttlMs: 60_000,
    onEvict: () => { throw new Error('hook blew up'); },
  });
  cache.set('a', 1);
  // Should not throw even though onEvict throws
  cache.set('b', 2);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('a'), false);
});
