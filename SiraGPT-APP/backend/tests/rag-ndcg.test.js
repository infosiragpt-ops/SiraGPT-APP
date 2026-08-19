/**
 * Tests for services/rag/ndcg.js — graded-relevance NDCG at k.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { ndcgAtK, meanNdcg } = require('../src/services/rag/ndcg');

// Close-enough float compare for NDCG fractions.
function approx(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ~${expected}, got ${actual} (diff=${Math.abs(actual - expected)})`,
  );
}

describe('ndcgAtK · input validation', () => {
  it('throws when ranked is not an array', () => {
    assert.throws(() => ndcgAtK('not-array', {}), /must be array/);
  });

  it('throws when relevance is null', () => {
    assert.throws(() => ndcgAtK([], null), /must be Map or object/);
  });

  it('accepts an empty Map relevance', () => {
    // Empty relevance → IDCG=0 → NaN.
    assert.ok(Number.isNaN(ndcgAtK(['a', 'b'], new Map())));
  });

  it('accepts an empty plain-object relevance', () => {
    assert.ok(Number.isNaN(ndcgAtK(['a', 'b'], {})));
  });
});

describe('ndcgAtK · perfect ordering', () => {
  it('returns 1.0 when the ranked list matches the ideal ordering', () => {
    const rel = { a: 3, b: 2, c: 1 };
    const ranked = ['a', 'b', 'c'];
    approx(ndcgAtK(ranked, rel, 10), 1.0);
  });

  it('still returns 1.0 when only top-k are correctly ordered', () => {
    // Even if there are more items, k=2 means we only consider the top
    // 2. If those match the top 2 in ideal, NDCG_2 = 1.0.
    const rel = { a: 3, b: 2, c: 1 };
    const ranked = ['a', 'b', 'c'];
    approx(ndcgAtK(ranked, rel, 2), 1.0);
  });
});

describe('ndcgAtK · empty / no-relevant cases', () => {
  it('returns NaN when there is no relevance signal at all (IDCG=0)', () => {
    const ranked = ['a', 'b', 'c'];
    assert.ok(Number.isNaN(ndcgAtK(ranked, { a: 0, b: 0 })));
  });

  it('returns 0 when ranked has no overlap with relevant items but goldenset is non-empty', () => {
    // The ideal exists (relevant items: x, y, z) but our ranked list
    // surfaces none of them. DCG = 0, IDCG > 0 → NDCG = 0.
    const ranked = ['a', 'b', 'c'];
    const rel = { x: 2, y: 1 };
    assert.equal(ndcgAtK(ranked, rel, 10), 0);
  });

  it('returns NaN for empty ranked AND empty relevance', () => {
    assert.ok(Number.isNaN(ndcgAtK([], {})));
  });
});

describe('ndcgAtK · position penalty (DCG behavior)', () => {
  it('penalizes lower positions: same item ranked 1st > ranked 3rd', () => {
    const rel = { hit: 2 };
    const top = ndcgAtK(['hit', 'x', 'y'], rel, 3);
    const bottom = ndcgAtK(['x', 'y', 'hit'], rel, 3);
    assert.ok(top > bottom, `top=${top} should exceed bottom=${bottom}`);
    approx(top, 1.0);  // hit at #1 with no other relevant items → perfect
  });

  it('uses graded relevance: rel=2 contributes 2^2 - 1 = 3 in numerator', () => {
    // Single item, rel=2, position 1: DCG = (2^2 - 1) / log2(2) = 3 / 1 = 3.
    // IDCG = same since only one relevant item → NDCG = 1.0.
    const rel = new Map([['hit', 2]]);
    approx(ndcgAtK(['hit'], rel, 1), 1.0);
  });

  it('Map and plain-object relevance produce identical NDCG', () => {
    const rankedA = ['a', 'b', 'c'];
    const objRel = { a: 2, b: 1, c: 0 };
    const mapRel = new Map(Object.entries(objRel));
    approx(ndcgAtK(rankedA, objRel, 10), ndcgAtK(rankedA, mapRel, 10));
  });
});

describe('ndcgAtK · k handling', () => {
  it('treats k <= 0 as k=1 (Math.max guard)', () => {
    const rel = { a: 2 };
    approx(ndcgAtK(['a'], rel, 0), 1.0);
    approx(ndcgAtK(['a'], rel, -5), 1.0);
  });

  it('respects k as a hard cutoff — items past k do not count', () => {
    // With k=1, only the first ranked item enters DCG.
    const rel = { a: 0, b: 2 };
    // ranked=['a','b'], k=1 → DCG considers only 'a' (rel=0) → DCG=0.
    // IDCG_1 considers the top-1 ideal item → (2^2-1)/log2(2) = 3.
    // NDCG = 0 / 3 = 0.
    assert.equal(ndcgAtK(['a', 'b'], rel, 1), 0);
  });
});

describe('meanNdcg', () => {
  it('averages NDCG across samples', () => {
    const samples = [
      { id: 'q1', ranked: ['a', 'b'], relevance: { a: 1 } }, // → 1.0
      { id: 'q2', ranked: ['b', 'a'], relevance: { a: 1 } }, // → 1/log2(3) ≈ 0.6309
    ];
    const out = meanNdcg(samples, 10);
    assert.equal(out.n, 2);
    assert.equal(out.per_query.length, 2);
    approx(out.mean, (1 + 1 / Math.log2(3)) / 2, 1e-6);
  });

  it('skips samples where IDCG=0 (NaN) when computing the mean', () => {
    const samples = [
      { id: 'q1', ranked: ['a'], relevance: { a: 1 } }, // → 1.0
      { id: 'q2', ranked: ['x'], relevance: {} },        // → NaN, skipped
    ];
    const out = meanNdcg(samples, 10);
    assert.equal(out.n, 1, 'NaN samples must not count toward n');
    approx(out.mean, 1.0);
    assert.equal(out.per_query.length, 2);
    assert.ok(Number.isNaN(out.per_query[1].ndcg));
  });

  it('returns NaN mean when ALL samples are non-judgeable', () => {
    const samples = [
      { id: 'q1', ranked: ['a'], relevance: {} },
      { id: 'q2', ranked: ['b'], relevance: {} },
    ];
    const out = meanNdcg(samples, 10);
    assert.equal(out.n, 0);
    assert.ok(Number.isNaN(out.mean));
  });

  it('preserves per_query order including null id fallback', () => {
    const samples = [
      { ranked: ['a'], relevance: { a: 1 } },
      { id: 'q2', ranked: ['b'], relevance: { b: 1 } },
    ];
    const out = meanNdcg(samples);
    assert.equal(out.per_query[0].id, null);
    assert.equal(out.per_query[1].id, 'q2');
  });

  it('default k=10 is used when none provided', () => {
    // Make a sample where the answer changes based on k. With k=10 all
    // relevant items fit so NDCG=1.0; with k=1 only the first counts.
    const sample = {
      ranked: ['a', 'b', 'c'],
      relevance: { a: 2, b: 1, c: 1 },
    };
    const out = meanNdcg([sample]);
    approx(out.mean, 1.0);
  });
});
