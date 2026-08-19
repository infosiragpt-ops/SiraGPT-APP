'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SemanticCache,
  cosineSim,
  normalize,
  buildScopeKey,
  extractSemanticQuery,
  isSemanticCacheEnabled,
  getSemanticCache,
  _resetSingletonForTests,
  DEFAULT_THRESHOLD,
} = require('../src/cache/semantic');

const llmCache = require('../src/cache/llm-cache');
const { TwoTier } = require('../src/cache/TwoTier');

// --- Pure helpers --------------------------------------------------------

test('cosineSim handles identical and orthogonal vectors', () => {
  assert.equal(cosineSim([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSim([1, 0, 0], [0, 1, 0]), 0);
  assert.ok(Math.abs(cosineSim([1, 1], [1, 1]) - 1) < 1e-9);
});

test('cosineSim returns 0 on zero or mismatched input', () => {
  assert.equal(cosineSim([0, 0], [1, 1]), 0);
  assert.equal(cosineSim([1, 2, 3], [1, 2]), 0);
  assert.equal(cosineSim(null, [1]), 0);
});

test('normalize returns a unit vector', () => {
  const u = normalize([3, 4]);
  assert.ok(Math.abs(u[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(u[1] - 0.8) < 1e-6);
  const mag = Math.sqrt(u[0] * u[0] + u[1] * u[1]);
  assert.ok(Math.abs(mag - 1) < 1e-6);
});

test('isSemanticCacheEnabled honors env flag', () => {
  assert.equal(isSemanticCacheEnabled({}), false);
  assert.equal(isSemanticCacheEnabled({ SIRA_SEMANTIC_CACHE_ENABLED: 'true' }), true);
  assert.equal(isSemanticCacheEnabled({ SIRA_SEMANTIC_CACHE_ENABLED: '0' }), false);
});

// --- SemanticCache store -------------------------------------------------

test('SemanticCache returns hit when similarity ≥ threshold', () => {
  const c = new SemanticCache({ threshold: 0.9 });
  c.set('s1', [1, 0, 0], 'answer-A');
  // Almost identical direction → cos ≈ 1.
  const hit = c.get('s1', [1, 0.05, 0]);
  assert.ok(hit, 'should hit');
  assert.equal(hit.value, 'answer-A');
  assert.ok(hit.similarity > 0.9);
});

test('SemanticCache misses when similarity < threshold', () => {
  const c = new SemanticCache({ threshold: 0.95 });
  c.set('s1', [1, 0, 0], 'answer-A');
  const miss = c.get('s1', [0.5, 0.5, 0]); // cos ~ 0.707
  assert.equal(miss, undefined);
});

test('SemanticCache scopes do not leak across each other', () => {
  const c = new SemanticCache({ threshold: 0.9 });
  c.set('model-A', [1, 0, 0], 'A');
  const hit = c.get('model-B', [1, 0.01, 0]);
  assert.equal(hit, undefined);
});

test('SemanticCache respects per-call threshold override', () => {
  const c = new SemanticCache({ threshold: 0.99 });
  c.set('s', [1, 0], 'A');
  // cos([1,0], [0.9, 0.4358]) ≈ 0.9
  const tight = c.get('s', [0.9, 0.4358]);
  assert.equal(tight, undefined);
  const loose = c.get('s', [0.9, 0.4358], { threshold: 0.85 });
  assert.ok(loose);
  assert.equal(loose.value, 'A');
});

test('SemanticCache expires entries by ttl', () => {
  let now = 1000;
  const c = new SemanticCache({ threshold: 0.9, defaultTtlMs: 100, now: () => now });
  c.set('s', [1, 0], 'A');
  assert.ok(c.get('s', [1, 0]));
  now += 200;
  assert.equal(c.get('s', [1, 0]), undefined);
});

test('SemanticCache pruneExpired drops stale entries', () => {
  let now = 0;
  const c = new SemanticCache({ threshold: 0.9, defaultTtlMs: 50, now: () => now });
  c.set('s', [1, 0], 'A');
  c.set('s', [0, 1], 'B', { ttlMs: 1000 });
  now = 100;
  const removed = c.pruneExpired();
  assert.equal(removed, 1);
  assert.equal(c.size, 1);
});

test('SemanticCache evicts oldest when over maxEntries', () => {
  let now = 0;
  const c = new SemanticCache({ threshold: 0.9, maxEntries: 2, defaultTtlMs: 10000, now: () => now });
  c.set('s', [1, 0, 0], 'A');
  now += 1;
  c.set('s', [0, 1, 0], 'B');
  now += 1;
  c.set('s', [0, 0, 1], 'C');
  assert.equal(c.size, 2);
  // 'A' (oldest expiresAt) should have been evicted.
  assert.equal(c.get('s', [1, 0, 0]), undefined);
  assert.ok(c.get('s', [0, 0, 1]));
});

test('SemanticCache rejects bad threshold and maxEntries', () => {
  assert.throws(() => new SemanticCache({ threshold: 0 }), RangeError);
  assert.throws(() => new SemanticCache({ threshold: 1.5 }), RangeError);
  assert.throws(() => new SemanticCache({ maxEntries: 0 }), RangeError);
});

test('SemanticCache.get drops bucket on dimension mismatch', () => {
  const c = new SemanticCache({ threshold: 0.9 });
  c.set('s', [1, 0, 0], 'A');
  const r = c.get('s', [1, 0]);
  assert.equal(r, undefined);
  assert.equal(c.size, 0);
});

test('SemanticCache.stats reports counters', () => {
  const c = new SemanticCache({ threshold: 0.9 });
  c.set('s', [1, 0], 'A');
  c.get('s', [1, 0]);
  c.get('s', [0, 1]); // miss
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.sets, 1);
  assert.equal(s.size, 1);
  assert.ok(s.hit_ratio > 0 && s.hit_ratio < 1);
});

// --- Helpers -------------------------------------------------------------

test('buildScopeKey separates by model and system', () => {
  const a = buildScopeKey({ model: 'gpt-4o', system: 'be helpful' });
  const b = buildScopeKey({ model: 'gpt-4o-mini', system: 'be helpful' });
  const c = buildScopeKey({ model: 'gpt-4o', system: 'be terse' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('extractSemanticQuery picks last user message', () => {
  const q = extractSemanticQuery({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'last question' },
    ],
  });
  assert.equal(q, 'last question');
});

test('extractSemanticQuery flattens multipart content', () => {
  const q = extractSemanticQuery({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }],
  });
  assert.equal(q, 'hello\nworld');
});

test('extractSemanticQuery returns null when no user text', () => {
  assert.equal(extractSemanticQuery({ messages: [] }), null);
  assert.equal(extractSemanticQuery({ messages: [{ role: 'system', content: 'x' }] }), null);
});

// --- getSemanticCache singleton ------------------------------------------

test('getSemanticCache returns same instance across calls', () => {
  _resetSingletonForTests();
  const a = getSemanticCache({ env: { SIRA_SEMANTIC_CACHE_ENABLED: '1' } });
  const b = getSemanticCache();
  assert.equal(a, b);
  _resetSingletonForTests();
});

test('getSemanticCache reads threshold from env', () => {
  _resetSingletonForTests();
  const c = getSemanticCache({ env: { SIRA_SEMANTIC_CACHE_THRESHOLD: '0.85' } });
  assert.equal(c.store.threshold, 0.85);
  _resetSingletonForTests();
});

// --- Integration with getOrCompute --------------------------------------

test('getOrCompute serves semantic hit on exact-cache miss', async () => {
  llmCache._resetSingletonForTests();
  _resetSingletonForTests();

  const env = { SIRA_CACHE_ENABLED: '1', SIRA_SEMANTIC_CACHE_ENABLED: '1' };
  const cache = new TwoTier({ l1MaxEntries: 100, l1TtlMs: 60000 });
  const semantic = getSemanticCache({
    env,
    embed: async (texts) => texts.map((t) => {
      // Tiny deterministic "embedding": map the first char + length so
      // very similar strings end up near each other.
      const base = (t.charCodeAt(0) || 0);
      return Float32Array.from([base, t.length, 1]);
    }),
  });

  const reqA = {
    model: 'm', system: 'sys',
    messages: [{ role: 'user', content: 'what is the capital of France?' }],
  };
  const reqB = {
    model: 'm', system: 'sys',
    // Same first char + length-ish, different exact key → semantic should still hit.
    messages: [{ role: 'user', content: 'what is the capital of france??' }],
  };

  let calls = 0;
  const compute = async () => { calls += 1; return 'Paris'; };

  const r1 = await llmCache.getOrCompute({ kind: 'chat', request: reqA, compute, cache, env, semantic });
  assert.equal(r1, 'Paris');
  assert.equal(calls, 1);

  // reqB has a different exact key; without semantic this would invoke compute again.
  const r2 = await llmCache.getOrCompute({ kind: 'chat', request: reqB, compute, cache, env, semantic });
  assert.equal(r2, 'Paris');
  // Compute should NOT have been invoked again — semantic served the answer.
  assert.equal(calls, 1);

  const snap = cache.snapshot();
  assert.ok(snap.semantic_hits >= 1, 'semantic_hits counter incremented');

  llmCache._resetSingletonForTests();
  _resetSingletonForTests();
});

test('getOrCompute falls through to compute when semantic disabled', async () => {
  llmCache._resetSingletonForTests();
  _resetSingletonForTests();

  const env = { SIRA_CACHE_ENABLED: '1' /* semantic OFF */ };
  const cache = new TwoTier({ l1MaxEntries: 100, l1TtlMs: 60000 });

  let calls = 0;
  const compute = async () => { calls += 1; return 'X'; };

  const reqA = { model: 'm', messages: [{ role: 'user', content: 'a' }] };
  const reqB = { model: 'm', messages: [{ role: 'user', content: 'b' }] };

  await llmCache.getOrCompute({ kind: 'chat', request: reqA, compute, cache, env });
  await llmCache.getOrCompute({ kind: 'chat', request: reqB, compute, cache, env });
  assert.equal(calls, 2);

  llmCache._resetSingletonForTests();
});

test('getOrCompute swallows embed errors and falls back to compute', async () => {
  llmCache._resetSingletonForTests();
  _resetSingletonForTests();

  const env = { SIRA_CACHE_ENABLED: '1', SIRA_SEMANTIC_CACHE_ENABLED: '1' };
  const cache = new TwoTier({ l1MaxEntries: 100, l1TtlMs: 60000 });
  const semantic = getSemanticCache({
    env,
    embed: async () => { throw new Error('boom'); },
  });

  const compute = async () => 'OK';
  const r = await llmCache.getOrCompute({
    kind: 'chat',
    request: { model: 'm', messages: [{ role: 'user', content: 'q' }] },
    compute, cache, env, semantic,
  });
  assert.equal(r, 'OK');

  llmCache._resetSingletonForTests();
  _resetSingletonForTests();
});

test('DEFAULT_THRESHOLD is 0.92 per spec', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.92);
});
