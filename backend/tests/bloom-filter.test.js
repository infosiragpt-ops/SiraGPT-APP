'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createBloomFilter,
  sizeForExpected,
  hashesForOptimal,
} = require('../src/services/observability/bloom-filter');

describe('sizing helpers', () => {
  test('sizeForExpected grows with -log(p)', () => {
    const a = sizeForExpected(1000, 0.01);
    const b = sizeForExpected(1000, 0.001);
    assert.ok(b > a);
  });

  test('hashesForOptimal returns a positive integer', () => {
    const k = hashesForOptimal(10_000, 1000);
    assert.ok(k >= 1 && k <= 16 && Number.isInteger(k));
  });
});

describe('createBloomFilter — basic', () => {
  test('add then has → true', () => {
    const bf = createBloomFilter({ expectedItems: 1000, falsePositive: 0.01 });
    bf.add('alice');
    assert.equal(bf.has('alice'), true);
  });

  test('has() on never-added is mostly false (no false negatives)', () => {
    const bf = createBloomFilter({ expectedItems: 1000, falsePositive: 0.001 });
    assert.equal(bf.has('never'), false);
  });

  test('null / undefined are no-ops on add and has', () => {
    const bf = createBloomFilter({});
    bf.add(null); bf.add(undefined);
    assert.equal(bf.has(null), false);
  });

  test('reset() clears the filter', () => {
    const bf = createBloomFilter({});
    bf.add('x');
    bf.reset();
    assert.equal(bf.has('x'), false);
    assert.equal(bf.snapshot().bitsSet, 0);
  });
});

describe('createBloomFilter — false-positive bound', () => {
  test('observed FP rate stays under target × 2 for n=1000 expected', () => {
    const target = 0.01;
    const bf = createBloomFilter({ expectedItems: 1000, falsePositive: target });
    for (let i = 0; i < 1000; i++) bf.add(`item:${i}`);
    let fp = 0;
    const trials = 10_000;
    for (let i = 0; i < trials; i++) {
      if (bf.has(`probe:${i}`)) fp += 1;
    }
    const observed = fp / trials;
    assert.ok(observed < target * 2, `observed FP ${observed} > 2× target ${target}`);
  });
});

describe('createBloomFilter — snapshot', () => {
  test('exposes config, bitsSet, fillRatio', () => {
    const bf = createBloomFilter({ size: 1024, hashes: 3 });
    bf.add('a'); bf.add('b');
    const s = bf.snapshot();
    assert.equal(s.size, 1024);
    assert.equal(s.hashes, 3);
    assert.ok(s.bitsSet > 0);
    assert.ok(s.fillRatio > 0 && s.fillRatio < 1);
  });

  test('estimatedItems approximates true count', () => {
    const bf = createBloomFilter({ expectedItems: 5000, falsePositive: 0.001 });
    for (let i = 0; i < 1000; i++) bf.add(`k:${i}`);
    const est = bf.snapshot().estimatedItems;
    assert.ok(est > 800 && est < 1200, `estimated ${est} not within ±20% of 1000`);
  });
});

describe('createBloomFilter — merge', () => {
  test('union of two filters contains both sets', () => {
    const a = createBloomFilter({ size: 1024, hashes: 4 });
    const b = createBloomFilter({ size: 1024, hashes: 4 });
    a.add('alice'); b.add('bob');
    a.merge(b);
    assert.equal(a.has('alice'), true);
    assert.equal(a.has('bob'), true);
  });

  test('merge dimension mismatch throws', () => {
    const a = createBloomFilter({ size: 1024, hashes: 4 });
    const b = createBloomFilter({ size: 2048, hashes: 4 });
    assert.throws(() => a.merge(b), TypeError);
  });

  test('merge with non-bloom throws', () => {
    const a = createBloomFilter({});
    assert.throws(() => a.merge({}), TypeError);
  });
});
