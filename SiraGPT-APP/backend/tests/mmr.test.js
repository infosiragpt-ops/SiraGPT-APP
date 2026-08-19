/**
 * Unit tests for services/mmr.js — Maximal Marginal Relevance.
 * Uses node:test (Node ≥ 18) so no new dependencies are needed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mmrRerank,
  tokenize,
  jaccardSimilarity,
  computeMMRScore,
  DEFAULT_LAMBDA,
} = require('../src/services/mmr');

test('tokenize splits on whitespace/punct and lowercases', () => {
  const tokens = tokenize('Hello, World! 123_test');
  assert.deepEqual([...tokens].sort(), ['123_test', 'hello', 'world'].sort());
});

test('tokenize preserves accented unicode letters', () => {
  const tokens = tokenize('niño Año café');
  assert.ok(tokens.has('niño'));
  assert.ok(tokens.has('año'));
  assert.ok(tokens.has('café'));
});

test('jaccardSimilarity: identical sets → 1, disjoint → 0', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccardSimilarity(new Set(['a']), new Set(['b'])), 0);
});

test('jaccardSimilarity: both empty → 1 (edge case)', () => {
  assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
});

test('jaccardSimilarity: one empty, other non-empty → 0', () => {
  assert.equal(jaccardSimilarity(new Set(), new Set(['a'])), 0);
});

test('computeMMRScore: λ=1 returns pure relevance', () => {
  assert.equal(computeMMRScore(0.8, 0.5, 1), 0.8);
});

test('computeMMRScore: λ=0 returns negative diversity penalty only', () => {
  assert.equal(computeMMRScore(0.8, 0.5, 0), -0.5);
});

test('mmrRerank: empty or single-item input returns copy as-is', () => {
  assert.deepEqual(mmrRerank([]), []);
  const single = [{ text: 'only', score: 0.9 }];
  const out = mmrRerank(single);
  assert.deepEqual(out, single);
  assert.notEqual(out, single); // new array
});

test('mmrRerank: λ=1 reduces to sort-by-score', () => {
  const items = [
    { text: 'c', score: 0.3 },
    { text: 'a', score: 0.9 },
    { text: 'b', score: 0.5 },
  ];
  const out = mmrRerank(items, { lambda: 1 });
  assert.deepEqual(out.map(i => i.text), ['a', 'b', 'c']);
});

test('mmrRerank: diversifies near-duplicate top hits', () => {
  // Three items in similar relevance band: the top one and a near-duplicate
  // share most tokens; the third is topically distinct. MMR with a
  // diversity-heavy λ should pick the distinct item for position 2, even
  // though a near-duplicate has marginally higher raw relevance.
  const items = [
    { text: 'pricing plan monthly cost details',   score: 0.90 }, // top relevant
    { text: 'pricing plan monthly cost billing',   score: 0.87 }, // near-dup of #0
    { text: 'refund policy details and terms',     score: 0.85 }, // distinct
  ];
  const reranked = mmrRerank(items, { lambda: 0.3, k: 2 });
  assert.equal(reranked.length, 2);
  assert.ok(reranked[0].text.includes('pricing'), 'first pick should be top-relevance');
  assert.ok(
    reranked[1].text.includes('refund'),
    `second pick should be the distinct item, got "${reranked[1].text}"`,
  );
});

test('mmrRerank: respects k parameter', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    text: `item ${i}`,
    score: 1 - i * 0.1,
  }));
  const out = mmrRerank(items, { k: 3 });
  assert.equal(out.length, 3);
});

test('mmrRerank: clamps λ outside [0,1]', () => {
  const items = [
    { text: 'a', score: 0.9 },
    { text: 'b', score: 0.5 },
  ];
  // λ=5 should clamp to 1 → pure relevance order preserved.
  const out = mmrRerank(items, { lambda: 5 });
  assert.equal(out[0].text, 'a');
});

test('mmrRerank: uses DEFAULT_LAMBDA when not specified', () => {
  assert.equal(DEFAULT_LAMBDA, 0.7);
});
