'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CacheMetrics } = require('../../src/cache/metrics');

test('CacheMetrics counts hits and misses', () => {
  const m = new CacheMetrics();
  m.recordL1Hit();
  m.recordL1Hit();
  m.recordL2Hit();
  m.recordMiss();
  const snap = m.snapshot();
  assert.equal(snap.l1_hits, 2);
  assert.equal(snap.l2_hits, 1);
  assert.equal(snap.misses, 1);
  assert.equal(snap.hit_ratio, 3 / 4);
});

test('CacheMetrics hit_ratio is zero with no traffic', () => {
  const m = new CacheMetrics();
  assert.equal(m.snapshot().hit_ratio, 0);
});

test('CacheMetrics records latency percentiles', () => {
  const m = new CacheMetrics();
  for (let i = 1; i <= 100; i += 1) m.recordLookupLatency(i * 10);
  const snap = m.snapshot();
  assert.ok(snap.lookup_p50_us > 0);
  assert.ok(snap.lookup_p95_us >= snap.lookup_p50_us);
  assert.equal(snap.lookup_samples, 100);
});

test('CacheMetrics rejects invalid latency values', () => {
  const m = new CacheMetrics();
  m.recordLookupLatency(NaN);
  m.recordLookupLatency(-1);
  assert.equal(m.snapshot().lookup_samples, 0);
});

test('CacheMetrics emits prom-format text', () => {
  const m = new CacheMetrics();
  m.recordL1Hit();
  m.recordMiss();
  m.recordL1Eviction();
  const text = m.toPromText('test_cache');
  assert.match(text, /test_cache_hits_total\{tier="l1"\} 1/);
  assert.match(text, /test_cache_misses_total 1/);
  assert.match(text, /test_cache_evictions_total 1/);
});

test('CacheMetrics reset clears counters', () => {
  const m = new CacheMetrics();
  m.recordL1Hit();
  m.recordMiss();
  m.reset();
  const snap = m.snapshot();
  assert.equal(snap.l1_hits, 0);
  assert.equal(snap.misses, 0);
});
