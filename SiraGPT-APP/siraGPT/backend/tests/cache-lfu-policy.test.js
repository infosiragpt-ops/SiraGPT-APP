'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryLRU, SUPPORTED_POLICIES } = require('../src/cache/MemoryLRU');
const { CacheMetrics } = require('../src/cache/metrics');
const { TwoTier } = require('../src/cache/TwoTier');

test('MemoryLRU supports lru and lfu policies', () => {
  assert.ok(SUPPORTED_POLICIES.has('lru'));
  assert.ok(SUPPORTED_POLICIES.has('lfu'));
  const lru = new MemoryLRU({ maxEntries: 4 });
  const lfu = new MemoryLRU({ maxEntries: 4, policy: 'lfu' });
  assert.equal(lru.policy, 'lru');
  assert.equal(lfu.policy, 'lfu');
});

test('MemoryLRU rejects unknown eviction policy', () => {
  assert.throws(() => new MemoryLRU({ policy: 'fifo' }), TypeError);
});

test('LFU evicts least-frequently-used entry, not least-recent', () => {
  const evicted = [];
  const lfu = new MemoryLRU({
    maxEntries: 3,
    ttlMs: 60_000,
    policy: 'lfu',
    onEvict: (k, _v, reason) => evicted.push({ k, reason }),
  });
  lfu.set('a', 1);
  lfu.set('b', 2);
  lfu.set('c', 3);
  // Bump frequencies so 'b' becomes the coldest.
  lfu.get('a'); lfu.get('a'); lfu.get('a');
  lfu.get('c'); lfu.get('c');
  // 'b' has freq 0 — should evict.
  lfu.set('d', 4);
  assert.equal(lfu.get('b'), undefined);
  assert.equal(lfu.get('a'), 1);
  assert.equal(lfu.get('c'), 3);
  assert.equal(lfu.get('d'), 4);
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0].k, 'b');
  assert.equal(evicted[0].reason, 'capacity');
});

test('LFU with all frequencies tied evicts oldest insertion', () => {
  const lfu = new MemoryLRU({ maxEntries: 2, policy: 'lfu' });
  lfu.set('a', 1);
  lfu.set('b', 2);
  // No reads — both freq 0. Insert 'c' → 'a' is the oldest, should go.
  lfu.set('c', 3);
  assert.equal(lfu.get('a'), undefined);
  assert.equal(lfu.get('b'), 2);
  assert.equal(lfu.get('c'), 3);
});

test('LFU preserves frequency on update of an existing key', () => {
  const lfu = new MemoryLRU({ maxEntries: 2, policy: 'lfu' });
  lfu.set('a', 1);
  lfu.set('b', 2);
  lfu.get('a'); lfu.get('a'); // a freq=2
  lfu.set('a', 99); // update — keep freq, do not evict
  assert.equal(lfu.get('a'), 99);
  assert.equal(lfu.size, 2);
  // Now insert 'c' — b should be evicted (lower freq than a).
  lfu.set('c', 3);
  assert.equal(lfu.get('b'), undefined);
  assert.equal(lfu.get('a'), 99);
  assert.equal(lfu.get('c'), 3);
});

test('LFU expires entries by TTL like LRU', () => {
  let now = 0;
  const lfu = new MemoryLRU({ maxEntries: 5, ttlMs: 100, policy: 'lfu', now: () => now });
  lfu.set('a', 1);
  assert.equal(lfu.get('a'), 1);
  now = 200;
  assert.equal(lfu.get('a'), undefined);
  assert.equal(lfu.has('a'), false);
});

test('MemoryLRU.stats() reports per-instance hits/misses keyed by policy', () => {
  const lru = new MemoryLRU({ maxEntries: 4 });
  lru.set('a', 1); lru.set('b', 2);
  lru.get('a'); lru.get('missing'); lru.get('b');
  const s = lru.stats();
  assert.equal(s.policy, 'lru');
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRatio - (2 / 3)) < 1e-9);
  lru.resetStats();
  assert.equal(lru.stats().hits, 0);
  assert.equal(lru.stats().misses, 0);
});

test('CacheMetrics tracks cache_hit_ratio_by_policy', () => {
  const m = new CacheMetrics();
  m.recordHitByPolicy('lru');
  m.recordHitByPolicy('lru');
  m.recordMissByPolicy('lru');
  m.recordHitByPolicy('lfu');
  m.recordMissByPolicy('lfu');
  m.recordMissByPolicy('lfu');
  const ratios = m.hitRatioByPolicy();
  assert.ok(Math.abs(ratios.lru - (2 / 3)) < 1e-9);
  assert.ok(Math.abs(ratios.lfu - (1 / 3)) < 1e-9);
  const snap = m.snapshot();
  assert.deepEqual(Object.keys(snap.cache_hit_ratio_by_policy).sort(), ['lfu', 'lru']);
  assert.equal(snap.cache_counts_by_policy.lru.hits, 2);
  assert.equal(snap.cache_counts_by_policy.lfu.misses, 2);
});

test('CacheMetrics.toPromText emits per-policy gauge', () => {
  const m = new CacheMetrics();
  m.recordHitByPolicy('lfu');
  m.recordMissByPolicy('lfu');
  const text = m.toPromText('sira_cache');
  assert.match(text, /sira_cache_hit_ratio_by_policy\{policy="lfu"\}/);
});

test('CacheMetrics handles unknown / falsy policy labels safely', () => {
  const m = new CacheMetrics();
  m.recordHitByPolicy('');
  m.recordMissByPolicy(undefined);
  const ratios = m.hitRatioByPolicy();
  assert.ok('unknown' in ratios);
});

test('TwoTier propagates l1 policy into per-policy metrics', async () => {
  const tt = new TwoTier({ l1MaxEntries: 8, l1Policy: 'lfu' });
  await tt.set('k1', 'v1');
  await tt.set('k2', 'v2');
  await tt.get('k1'); // hit
  await tt.get('k1'); // hit
  await tt.get('missing'); // miss
  const snap = tt.snapshot();
  assert.ok(snap.cache_hit_ratio_by_policy.lfu > 0);
  assert.equal(snap.cache_counts_by_policy.lfu.hits, 2);
  assert.equal(snap.cache_counts_by_policy.lfu.misses, 1);
  assert.equal(tt.l1.policy, 'lfu');
});

test('TwoTier defaults to lru policy when none specified', async () => {
  const tt = new TwoTier({ l1MaxEntries: 4 });
  await tt.set('a', 1);
  await tt.get('a');
  await tt.get('missing');
  const snap = tt.snapshot();
  assert.ok('lru' in snap.cache_hit_ratio_by_policy);
  assert.equal(tt.l1.policy, 'lru');
});
