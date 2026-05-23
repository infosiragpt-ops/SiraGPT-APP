/**
 * Tests for multi-source retrieval fusion.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ms = require('../src/services/rag/multi-source');

// ─── fuseWeighted ────────────────────────────────────────────────────────

test('fuseWeighted: sums RRF scores across sources', () => {
  const perSource = {
    vec: [
      { source: 'doc1', text: 'alpha beta gamma' },
      { source: 'doc2', text: 'delta' },
    ],
    bm25: [
      { source: 'doc2', text: 'delta' },          // duplicate of vec[1]
      { source: 'doc3', text: 'unique to bm25' },
    ],
  };
  const { fused, contributions } = ms.fuseWeighted({ perSource, k: 5 });
  assert.equal(contributions.vec, 2);
  assert.equal(contributions.bm25, 2);
  // doc2 appears in both → should have highest combined score.
  assert.equal(fused[0].source, 'doc2');
  assert.ok(fused[0].sources.includes('vec'));
  assert.ok(fused[0].sources.includes('bm25'));
  assert.equal(fused.length, 3);
});

test('fuseWeighted: per-source weights shift ranking', () => {
  const perSource = {
    vec: [{ source: 'A', text: 'x' }],
    web: [{ source: 'B', text: 'y' }],
  };
  // With weight 3× on web, B should outrank A even though both are rank 1.
  const weighted = ms.fuseWeighted({
    perSource,
    weights: { vec: 1, web: 3 },
  });
  assert.equal(weighted.fused[0].source, 'B');
  const neutral = ms.fuseWeighted({ perSource });
  // Without weighting, tiebreak by insertion order keeps A first.
  assert.equal(neutral.fused[0].source, 'A');
});

test('fuseWeighted: empty input → empty fused', () => {
  const out = ms.fuseWeighted({ perSource: {} });
  assert.deepEqual(out.fused, []);
});

test('fuseWeighted: respects top-k cap', () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ source: `s${i}`, text: `t${i}` }));
  const out = ms.fuseWeighted({ perSource: { src: list }, k: 3 });
  assert.equal(out.fused.length, 3);
});

// ─── fanOutAndFuse ───────────────────────────────────────────────────────

test('fanOutAndFuse: calls retrievers concurrently, returns per-source timings', async () => {
  const retrievers = {
    fast: async () => [{ source: 'f1', text: 'a' }, { source: 'f2', text: 'b' }],
    slow: async () => new Promise(r => setTimeout(() => r([{ source: 's1', text: 'c' }]), 30)),
  };
  const out = await ms.fanOutAndFuse({ query: 'q', retrievers });
  assert.equal(out.contributions.fast.count, 2);
  assert.equal(out.contributions.slow.count, 1);
  assert.ok(out.contributions.slow.durationMs >= 25);
  assert.equal(out.fused.length, 3);
});

test('fanOutAndFuse: retriever error is captured per-source, others still run', async () => {
  const retrievers = {
    good: async () => [{ source: 'g', text: 'ok' }],
    bad: async () => { throw new Error('kaput'); },
  };
  const out = await ms.fanOutAndFuse({ query: 'q', retrievers });
  assert.equal(out.contributions.good.count, 1);
  assert.equal(out.contributions.bad.count, 0);
  assert.match(out.contributions.bad.error, /kaput/);
  assert.equal(out.fused.length, 1);
  assert.equal(out.fused[0].source, 'g');
});

test('fanOutAndFuse: retriever timeout surfaces in contributions', async () => {
  const retrievers = {
    slow: async () => new Promise(r => setTimeout(() => r([{ source: 's', text: 'x' }]), 100)),
  };
  const out = await ms.fanOutAndFuse({ query: 'q', retrievers, timeoutMs: 10 });
  assert.equal(out.contributions.slow.count, 0);
  assert.match(out.contributions.slow.error, /timeout/);
});

test('fanOutAndFuse: empty retrievers map → empty fused', async () => {
  const out = await ms.fanOutAndFuse({ query: 'q', retrievers: {} });
  assert.deepEqual(out.fused, []);
});

test('fanOutAndFuse: weights propagate into the fused ranking', async () => {
  const retrievers = {
    cheap: async () => [{ source: 'C', text: 'a' }],
    premium: async () => [{ source: 'P', text: 'b' }],
  };
  const out = await ms.fanOutAndFuse({
    query: 'q',
    retrievers,
    weights: { cheap: 0.1, premium: 10 },
  });
  assert.equal(out.fused[0].source, 'P');
  assert.equal(out.weights.premium, 10);
});
