'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  hash32, mulberry32, sampleByKey, reservoir, weightedChoice, shuffle,
} = require('../src/utils/deterministic-sampler');

describe('hash32', () => {
  test('deterministic + non-trivial', () => {
    assert.equal(hash32('foo'), hash32('foo'));
    assert.notEqual(hash32('foo'), hash32('bar'));
  });
  test('coerces non-strings', () => {
    assert.equal(hash32(123), hash32('123'));
  });
});

describe('mulberry32', () => {
  test('seed produces reproducible sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) assert.equal(a(), b());
  });
  test('values stay in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1);
    }
  });
  test('different seeds diverge', () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    assert.notEqual(a, b);
  });
});

describe('sampleByKey', () => {
  test('rate=0 → never sampled, rate=1 → always sampled', () => {
    assert.equal(sampleByKey('anything', 0), false);
    assert.equal(sampleByKey('anything', 1), true);
  });
  test('roughly hits target rate over many keys', () => {
    let hits = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) if (sampleByKey('req-' + i, 0.1)) hits++;
    // Expect ~10% with generous tolerance
    assert.ok(hits > N * 0.07 && hits < N * 0.13, `got ${hits}`);
  });
  test('same key always same decision', () => {
    const a = sampleByKey('trace-x', 0.5);
    const b = sampleByKey('trace-x', 0.5);
    assert.equal(a, b);
  });
});

describe('reservoir', () => {
  test('returns all items when k >= n', () => {
    const out = reservoir([1, 2, 3], 10, mulberry32(1));
    assert.deepEqual(out.sort(), [1, 2, 3]);
  });
  test('returns exactly k items when k < n', () => {
    const out = reservoir([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, mulberry32(1));
    assert.equal(out.length, 3);
    for (const v of out) assert.ok(v >= 1 && v <= 10);
  });
  test('seeded RNG → reproducible sample', () => {
    const a = reservoir(Array.from({ length: 50 }, (_, i) => i), 5, mulberry32(99));
    const b = reservoir(Array.from({ length: 50 }, (_, i) => i), 5, mulberry32(99));
    assert.deepEqual(a, b);
  });
  test('k=0 returns empty', () => {
    assert.deepEqual(reservoir([1, 2, 3], 0), []);
  });
  test('rejects non-iterable', () => {
    assert.throws(() => reservoir(null, 3), TypeError);
  });
  test('approximately uniform — each item appears ~k/n of the time', () => {
    const N = 10, K = 3, TRIALS = 5000;
    const counts = new Array(N).fill(0);
    for (let t = 0; t < TRIALS; t++) {
      const sample = reservoir(Array.from({ length: N }, (_, i) => i), K, mulberry32(t + 1));
      for (const v of sample) counts[v]++;
    }
    const expected = TRIALS * K / N; // 1500
    for (const c of counts) {
      assert.ok(Math.abs(c - expected) < expected * 0.1, `count ${c} far from ${expected}`);
    }
  });
});

describe('weightedChoice', () => {
  test('item with weight 0 never picked', () => {
    const items = [
      { value: 'A', weight: 0 },
      { value: 'B', weight: 1 },
    ];
    for (let i = 0; i < 100; i++) {
      assert.equal(weightedChoice(items, mulberry32(i + 1)), 'B');
    }
  });
  test('roughly respects weights', () => {
    const items = [
      { value: 'A', weight: 1 },
      { value: 'B', weight: 4 },
    ];
    const counts = { A: 0, B: 0 };
    const rng = mulberry32(123);
    for (let i = 0; i < 5000; i++) counts[weightedChoice(items, rng)]++;
    // B should be ~4× A
    const ratio = counts.B / counts.A;
    assert.ok(ratio > 3 && ratio < 5, `ratio=${ratio}`);
  });
  test('empty / all-zero returns undefined', () => {
    assert.equal(weightedChoice([]), undefined);
    assert.equal(weightedChoice([{ value: 'x', weight: 0 }]), undefined);
  });
});

describe('shuffle', () => {
  test('returns the same array (in place) with same elements', () => {
    const a = [1, 2, 3, 4, 5];
    const b = shuffle(a, mulberry32(1));
    assert.equal(a, b);
    assert.deepEqual([...a].sort((x, y) => x - y), [1, 2, 3, 4, 5]);
  });
  test('seeded shuffle is reproducible', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6, 7], mulberry32(50));
    const b = shuffle([1, 2, 3, 4, 5, 6, 7], mulberry32(50));
    assert.deepEqual(a, b);
  });
});
