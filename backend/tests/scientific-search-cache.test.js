'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cacheMod = require('../src/services/scientific-search-cache');
const { cacheKey, get, set, clear, stats, DEFAULT_TTL_MS } = cacheMod;

test.beforeEach(() => clear());

test('exports the documented surface', () => {
  assert.equal(typeof cacheKey, 'function');
  assert.equal(typeof get, 'function');
  assert.equal(typeof set, 'function');
  assert.equal(typeof clear, 'function');
  assert.equal(typeof stats, 'function');
  assert.equal(typeof DEFAULT_TTL_MS, 'number');
  assert.ok(DEFAULT_TTL_MS > 0);
});

test('cacheKey is deterministic for the same query + opts', () => {
  const k1 = cacheKey('quantum mechanics', { providers: ['arxiv', 'openalex'], limit: 10 });
  const k2 = cacheKey('quantum mechanics', { providers: ['openalex', 'arxiv'], limit: 10 });
  // Provider order should not change the key (it gets sorted).
  assert.equal(k1, k2);
});

test('cacheKey is case-insensitive and trims whitespace', () => {
  const k1 = cacheKey('Photosynthesis');
  const k2 = cacheKey('  photosynthesis  ');
  assert.equal(k1, k2);
});

test('cacheKey changes when any input changes', () => {
  const base = cacheKey('topic', { providers: ['arxiv'], limit: 10, timeoutMs: 5000 });
  assert.notEqual(base, cacheKey('topic2', { providers: ['arxiv'], limit: 10, timeoutMs: 5000 }));
  assert.notEqual(base, cacheKey('topic', { providers: ['openalex'], limit: 10, timeoutMs: 5000 }));
  assert.notEqual(base, cacheKey('topic', { providers: ['arxiv'], limit: 20, timeoutMs: 5000 }));
  assert.notEqual(base, cacheKey('topic', { providers: ['arxiv'], limit: 10, timeoutMs: 9000 }));
});

test('cacheKey returns a hex-string of stable length', () => {
  const k = cacheKey('whatever');
  assert.match(k, /^[a-f0-9]{24}$/);
});

test('get returns null for a missing key', () => {
  assert.equal(get('nonexistent topic'), null);
});

test('set + get round-trip returns the stored value with cache metadata', () => {
  set('photosynthesis', { providers: ['arxiv'] }, { papers: [{ title: 'paper-1' }] });
  const out = get('photosynthesis', { providers: ['arxiv'] });
  assert.ok(out, 'expected a cached row');
  assert.deepEqual(out.papers, [{ title: 'paper-1' }]);
  assert.equal(out._cache.hit, true);
  assert.ok(typeof out._cache.ageMs === 'number');
  assert.ok(out._cache.ageMs >= 0);
});

test('get returns null and evicts when the row is expired', () => {
  // Use a tiny TTL — the floor enforces 60_000ms, so manipulate via fake time
  // by mutating internal state isn't easy; instead, set a row with a custom
  // past expiresAt by going through the public API and waiting won't work
  // for a deterministic test. Use the floor TTL but advance Date.now via
  // a trampoline. Simpler: set, then directly assert: after the floor
  // window passes (we can't wait 60s) the row is considered expired.
  // Easiest: stub Date.now while keeping the contract clean.
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    set('topic', {}, { papers: [] }, 60_000);
    assert.ok(get('topic', {}), 'fresh row must hit');
    t += 65_000; // advance past the floor TTL
    assert.equal(get('topic', {}), null, 'expired row must evict');
  } finally {
    Date.now = realNow;
  }
});

test('set enforces a minimum TTL of 60_000ms even when caller asks for less', () => {
  // Internal contract: max(60_000, ttlMs). Verify by giving 1ms — the row
  // must still live for ~60s.
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    set('topic', {}, { papers: ['a'] }, 1);
    t += 30_000; // 30s — still under the 60s floor
    assert.ok(get('topic', {}), 'row must still be cached at 30s due to TTL floor');
  } finally {
    Date.now = realNow;
  }
});

test('clear empties the cache', () => {
  set('a', {}, { papers: [1] });
  set('b', {}, { papers: [2] });
  assert.equal(stats().size, 2);
  clear();
  assert.equal(stats().size, 0);
  assert.equal(get('a', {}), null);
});

test('stats reports size, maxEntries, and ttlMs', () => {
  const out = stats();
  assert.equal(typeof out.size, 'number');
  assert.equal(typeof out.maxEntries, 'number');
  assert.equal(typeof out.ttlMs, 'number');
  set('x', {}, {});
  assert.equal(stats().size, 1);
});

test('set evicts the oldest entry when the cache exceeds MAX_ENTRIES', () => {
  // Cap is configurable via env; default 200. We can't realistically fill
  // 200 entries cheaply but the eviction is FIFO (Map iteration order).
  // Verify the FIFO contract by directly forcing the size + setting one more.
  // The realistic alternative: spin up MAX_ENTRIES + 1 entries.
  const max = stats().maxEntries;
  // Cap to a sane number for the test runtime — we use min(max, 30).
  const target = Math.min(max, 30);
  // Force eviction by re-stubbing MAX via a tighter expectation: just check
  // the first inserted key is evicted once we exceed the configured cap.
  for (let i = 0; i < max + 5; i++) {
    set(`topic-${i}`, {}, { papers: [i] });
  }
  assert.ok(stats().size <= max, 'size must not exceed maxEntries');
  // The very first key must be evicted.
  assert.equal(get('topic-0', {}), null, 'oldest entry must have been evicted');
  // A late entry must still be present.
  assert.ok(get(`topic-${max + 4}`, {}), 'most recent entry must be cached');
});
