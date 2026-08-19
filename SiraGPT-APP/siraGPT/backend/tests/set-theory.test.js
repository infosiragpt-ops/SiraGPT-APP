'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  asSet,
  intersection,
  union,
  difference,
  symmetricDifference,
  isSubset,
  isSuperset,
  disjoint,
  jaccard,
  sorensenDice,
} = require('../src/utils/set-theory');

const sortArr = (s) => [...s].sort();

describe('asSet', () => {
  test('Set passthrough', () => {
    const s = new Set([1, 2]);
    assert.equal(asSet(s), s);
  });
  test('array → set', () => {
    assert.deepEqual(sortArr(asSet([1, 2, 2, 3])), [1, 2, 3]);
  });
  test('null/undefined → empty set', () => {
    assert.equal(asSet(null).size, 0);
    assert.equal(asSet(undefined).size, 0);
  });
  test('non-iterable throws', () => {
    assert.throws(() => asSet(42), TypeError);
  });
});

describe('intersection / union / difference / symmetricDifference', () => {
  const a = [1, 2, 3, 4];
  const b = [3, 4, 5, 6];
  test('intersection', () => {
    assert.deepEqual(sortArr(intersection(a, b)), [3, 4]);
  });
  test('union', () => {
    assert.deepEqual(sortArr(union(a, b)), [1, 2, 3, 4, 5, 6]);
  });
  test('difference (a \\ b)', () => {
    assert.deepEqual(sortArr(difference(a, b)), [1, 2]);
  });
  test('symmetric difference', () => {
    assert.deepEqual(sortArr(symmetricDifference(a, b)), [1, 2, 5, 6]);
  });
  test('intersection with empty → empty', () => {
    assert.equal(intersection([], a).size, 0);
  });
});

describe('subset / superset / disjoint', () => {
  test('isSubset true / false', () => {
    assert.equal(isSubset([1, 2], [1, 2, 3]), true);
    assert.equal(isSubset([1, 4], [1, 2, 3]), false);
  });
  test('isSuperset is reverse of isSubset', () => {
    assert.equal(isSuperset([1, 2, 3], [1, 2]), true);
    assert.equal(isSuperset([1, 2], [1, 2, 3]), false);
  });
  test('disjoint detects no-overlap', () => {
    assert.equal(disjoint([1, 2], [3, 4]), true);
    assert.equal(disjoint([1, 2], [2, 3]), false);
  });
  test('empty set is subset of everything', () => {
    assert.equal(isSubset([], [1, 2]), true);
    assert.equal(isSubset([], []), true);
  });
});

describe('similarity coefficients', () => {
  test('jaccard identical = 1', () => {
    assert.equal(jaccard([1, 2, 3], [1, 2, 3]), 1);
  });
  test('jaccard disjoint = 0', () => {
    assert.equal(jaccard([1, 2], [3, 4]), 0);
  });
  test('jaccard fractional case', () => {
    // |{1,2,3} ∩ {2,3,4}| = 2; |union| = 4 → 0.5
    assert.equal(jaccard([1, 2, 3], [2, 3, 4]), 0.5);
  });
  test('jaccard both-empty = 1 (convention)', () => {
    assert.equal(jaccard([], []), 1);
  });
  test('sorensenDice identical = 1', () => {
    assert.equal(sorensenDice([1, 2], [1, 2]), 1);
  });
  test('sorensenDice formula: 2|inter|/(|a|+|b|)', () => {
    // inter=2, |a|=3, |b|=3 → 4/6 ≈ 0.6667
    const v = sorensenDice([1, 2, 3], [2, 3, 4]);
    assert.ok(Math.abs(v - 4 / 6) < 1e-9);
  });
});
