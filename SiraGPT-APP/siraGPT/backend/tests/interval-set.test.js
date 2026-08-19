'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { IntervalSet, normalize } = require('../src/utils/interval-set');

describe('normalize', () => {
  test('merges overlapping + adjacent intervals', () => {
    assert.deepEqual(normalize([[0, 5], [3, 7], [8, 10]]), [[0, 7], [8, 10]]);
  });
  test('drops zero-length and inverted intervals', () => {
    assert.deepEqual(normalize([[0, 0], [5, 3]]), []);
  });
  test('sorts unsorted input', () => {
    assert.deepEqual(normalize([[5, 7], [0, 3]]), [[0, 3], [5, 7]]);
  });
});

describe('IntervalSet — add', () => {
  test('add into empty', () => {
    const s = IntervalSet.from([]).add(0, 10);
    assert.deepEqual(s.toArray(), [[0, 10]]);
  });
  test('add merges adjacent', () => {
    const s = IntervalSet.from([[0, 5]]).add(5, 10);
    assert.deepEqual(s.toArray(), [[0, 10]]);
  });
  test('add of inverted/zero range is no-op', () => {
    const a = IntervalSet.from([[0, 5]]);
    assert.deepEqual(a.add(7, 7).toArray(), [[0, 5]]);
    assert.deepEqual(a.add(7, 5).toArray(), [[0, 5]]);
  });
  test('returns NEW set (immutable)', () => {
    const a = IntervalSet.from([[0, 1]]);
    const b = a.add(5, 6);
    assert.notEqual(a, b);
    assert.equal(a.size, 1);
    assert.equal(b.size, 2);
  });
});

describe('IntervalSet — subtract', () => {
  test('subtract middle splits interval', () => {
    const s = IntervalSet.from([[0, 10]]).subtract(3, 7);
    assert.deepEqual(s.toArray(), [[0, 3], [7, 10]]);
  });
  test('subtract that fully covers removes interval', () => {
    const s = IntervalSet.from([[0, 5]]).subtract(0, 10);
    assert.deepEqual(s.toArray(), []);
  });
  test('subtract that does not overlap is no-op', () => {
    const s = IntervalSet.from([[0, 5]]).subtract(10, 20);
    assert.deepEqual(s.toArray(), [[0, 5]]);
  });
});

describe('IntervalSet — contains', () => {
  test('containsPoint reflects coverage', () => {
    const s = IntervalSet.from([[0, 5], [10, 15]]);
    assert.equal(s.containsPoint(2), true);
    assert.equal(s.containsPoint(5), false); // half-open
    assert.equal(s.containsPoint(7), false);
    assert.equal(s.containsPoint(12), true);
  });
  test('containsRange checks contiguous span', () => {
    const s = IntervalSet.from([[0, 10]]);
    assert.equal(s.containsRange(2, 8), true);
    assert.equal(s.containsRange(0, 10), true);
    assert.equal(s.containsRange(5, 12), false);
  });
});

describe('IntervalSet — gaps', () => {
  test('returns missing slices in [min, max)', () => {
    const s = IntervalSet.from([[2, 5], [8, 10]]);
    assert.deepEqual(s.gaps(0, 12), [[0, 2], [5, 8], [10, 12]]);
  });
  test('full coverage → []', () => {
    const s = IntervalSet.from([[0, 100]]);
    assert.deepEqual(s.gaps(10, 90), []);
  });
  test('empty set → entire window', () => {
    const s = IntervalSet.from([]);
    assert.deepEqual(s.gaps(0, 5), [[0, 5]]);
  });
});

describe('IntervalSet — union + intersect', () => {
  test('union merges across both sets', () => {
    const a = IntervalSet.from([[0, 5]]);
    const b = IntervalSet.from([[3, 8]]);
    assert.deepEqual(a.union(b).toArray(), [[0, 8]]);
  });
  test('intersect returns common spans', () => {
    const a = IntervalSet.from([[0, 5], [10, 15]]);
    const b = IntervalSet.from([[3, 12]]);
    assert.deepEqual(a.intersect(b).toArray(), [[3, 5], [10, 12]]);
  });
  test('union/intersect type-check', () => {
    const a = IntervalSet.from([[0, 1]]);
    assert.throws(() => a.union({}), TypeError);
    assert.throws(() => a.intersect({}), TypeError);
  });
});

describe('IntervalSet — totalLength + size', () => {
  test('totalLength sums non-overlapping', () => {
    const s = IntervalSet.from([[0, 5], [10, 12]]);
    assert.equal(s.totalLength(), 7);
  });
  test('size reflects merged count', () => {
    assert.equal(IntervalSet.from([[0, 5], [3, 8]]).size, 1);
  });
});
