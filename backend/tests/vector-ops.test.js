'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  l2norm,
  l2normalize,
  l2normalizeInto,
  dot,
  cosine,
  cosineNormalized,
  topK,
  normalizeBatch,
} = require('../src/services/rag/vector-ops');

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('l2norm / l2normalize', () => {
  test('l2norm of [3,4] = 5', () => {
    assert.equal(l2norm([3, 4]), 5);
  });
  test('l2normalize unit-vector unchanged', () => {
    const v = l2normalize([1, 0, 0]);
    assert.ok(close(v[0], 1));
  });
  test('l2normalize zero-vector → all zeros', () => {
    const v = l2normalize([0, 0, 0]);
    assert.deepEqual(Array.from(v), [0, 0, 0]);
  });
  test('l2normalize returns Float32Array', () => {
    assert.ok(l2normalize([1, 2, 3]) instanceof Float32Array);
  });
  test('l2normalizeInto mutates in place', () => {
    const v = new Float32Array([3, 4]);
    l2normalizeInto(v);
    assert.ok(close(v[0], 0.6));
    assert.ok(close(v[1], 0.8));
  });
});

describe('dot / cosine', () => {
  test('dot of orthogonal vectors is 0', () => {
    assert.equal(dot([1, 0], [0, 1]), 0);
  });
  test('dot of identical vectors is squared norm', () => {
    assert.equal(dot([2, 3], [2, 3]), 13);
  });
  test('cosine of identical = 1', () => {
    assert.ok(close(cosine([1, 2, 3], [1, 2, 3]), 1));
  });
  test('cosine of opposite = -1', () => {
    assert.ok(close(cosine([1, 0], [-1, 0]), -1));
  });
  test('cosine of orthogonal = 0', () => {
    assert.ok(close(cosine([1, 0], [0, 1]), 0));
  });
  test('cosine of zero vector → 0 (no NaN)', () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });
  test('cosine clamped to [-1, 1] under FP drift', () => {
    const v = l2normalize([1, 2, 3]);
    const s = cosine(v, v);
    assert.ok(s >= -1 && s <= 1);
  });
  test('throws on length mismatch', () => {
    assert.throws(() => cosine([1, 2], [1, 2, 3]), TypeError);
    assert.throws(() => dot([1], [1, 2]), TypeError);
  });
});

describe('cosineNormalized fast path', () => {
  test('matches cosine on pre-normalized inputs', () => {
    const a = l2normalize([1, 2, 3, 4]);
    const b = l2normalize([4, 3, 2, 1]);
    assert.ok(close(cosineNormalized(a, b), cosine(a, b)));
  });
  test('clamps drift', () => {
    const a = l2normalize([1, 2, 3]);
    assert.ok(cosineNormalized(a, a) <= 1);
  });
});

describe('topK', () => {
  test('returns the top-k by descending score', () => {
    const q = [1, 0];
    const vs = [
      [1, 0],         // 1.0
      [0.7, 0.7],     // ~0.707
      [0, 1],         // 0
      [-1, 0],        // -1
      [0.99, 0.01],   // ~1
    ];
    const out = topK(q, vs, 3);
    assert.equal(out.length, 3);
    assert.ok(out[0].score >= out[1].score);
    assert.ok(out[1].score >= out[2].score);
  });

  test('uses provided ids', () => {
    const q = [1, 0];
    const out = topK(q, [[1, 0], [0, 1]], 2, { ids: ['cat', 'dog'] });
    assert.equal(out[0].id, 'cat');
    assert.equal(out[1].id, 'dog');
  });

  test('skips vectors with mismatched length', () => {
    const out = topK([1, 0], [[1, 0], [1, 0, 0]], 5);
    assert.equal(out.length, 1);
  });

  test('rejects bad inputs', () => {
    assert.throws(() => topK(null, [], 5), TypeError);
    assert.throws(() => topK([1], 'nope', 5), TypeError);
    assert.throws(() => topK([1], [[1]], 1, { ids: ['a', 'b'] }), TypeError);
  });

  test('normalized=true uses fast path', () => {
    const q = l2normalize([1, 2, 3]);
    const vs = [l2normalize([1, 2, 3]), l2normalize([4, 5, 6])];
    const fast = topK(q, vs, 2, { normalized: true });
    const slow = topK(q, vs, 2);
    assert.equal(fast[0].id, slow[0].id);
  });

  test('default k=10 when not specified', () => {
    const q = [1, 0];
    const out = topK(q, Array.from({ length: 50 }, () => [1, 0]), undefined);
    assert.equal(out.length, 10);
  });
});

describe('normalizeBatch', () => {
  test('returns Float32Array per input', () => {
    const out = normalizeBatch([[1, 0], [0, 2]]);
    assert.equal(out.length, 2);
    assert.ok(out[0] instanceof Float32Array);
    assert.ok(close(l2norm(out[0]), 1));
    assert.ok(close(l2norm(out[1]), 1));
  });
  test('rejects non-array input', () => {
    assert.throws(() => normalizeBatch('nope'), TypeError);
  });
});
