'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createCountMinSketch } = require('../src/services/observability/count-min-sketch');

describe('createCountMinSketch — basic', () => {
  test('estimate of unseen key is 0', () => {
    const cms = createCountMinSketch({});
    assert.equal(cms.estimate('never'), 0);
  });

  test('estimate >= true count after adds', () => {
    const cms = createCountMinSketch({ width: 1024, depth: 4 });
    for (let i = 0; i < 10; i++) cms.add('alice');
    for (let i = 0; i < 3; i++) cms.add('bob');
    assert.ok(cms.estimate('alice') >= 10);
    assert.ok(cms.estimate('bob') >= 3);
    assert.equal(cms.estimate('unknown'), 0); // probably; ε is small
  });

  test('add(key, n) increments by n', () => {
    const cms = createCountMinSketch({});
    cms.add('x', 50);
    assert.ok(cms.estimate('x') >= 50);
  });

  test('null / 0 / negative count are no-ops', () => {
    const cms = createCountMinSketch({});
    cms.add(null);
    cms.add('x', 0);
    cms.add('x', -5);
    assert.equal(cms.estimate('x'), 0);
  });
});

describe('createCountMinSketch — accuracy under load', () => {
  test('100 distinct items, mostly accurate estimates', () => {
    const cms = createCountMinSketch({ width: 4096, depth: 5 });
    const truth = new Map();
    for (let i = 0; i < 100; i++) {
      const k = `key:${i}`;
      const n = (i % 7) + 1;
      cms.add(k, n);
      truth.set(k, n);
    }
    let overshoot = 0;
    for (const [k, real] of truth) {
      const est = cms.estimate(k);
      assert.ok(est >= real, `est ${est} < real ${real} for ${k}`);
      overshoot += est - real;
    }
    // With ε=e/4096 and few items, total overshoot should be tiny.
    assert.ok(overshoot < 100, `total overshoot ${overshoot} too high`);
  });

  test('heavy item dominates estimate', () => {
    const cms = createCountMinSketch({});
    for (let i = 0; i < 10_000; i++) cms.add('hot');
    for (let i = 0; i < 100; i++) cms.add(`cold:${i}`);
    assert.ok(cms.estimate('hot') >= 10_000);
    for (let i = 0; i < 100; i++) {
      assert.ok(cms.estimate(`cold:${i}`) <= 200);
    }
  });
});

describe('createCountMinSketch — heavy hitters', () => {
  test('returns keys above threshold sorted desc', () => {
    const cms = createCountMinSketch({});
    cms.add('a', 100);
    cms.add('b', 50);
    cms.add('c', 5);
    const hh = cms.heavyHitters(20);
    assert.equal(hh[0].key, 'a');
    assert.equal(hh[1].key, 'b');
    assert.ok(!hh.find((x) => x.key === 'c'));
  });
});

describe('createCountMinSketch — merge', () => {
  test('element-wise max merge preserves upper bound', () => {
    const a = createCountMinSketch({ width: 1024, depth: 4 });
    const b = createCountMinSketch({ width: 1024, depth: 4 });
    a.add('x', 5);
    b.add('x', 8);
    a.merge(b);
    assert.ok(a.estimate('x') >= 8);
  });

  test('merge dimension mismatch throws', () => {
    const a = createCountMinSketch({ width: 1024, depth: 4 });
    const b = createCountMinSketch({ width: 512, depth: 4 });
    assert.throws(() => a.merge(b), TypeError);
  });

  test('merge with non-CMS throws', () => {
    const a = createCountMinSketch({});
    assert.throws(() => a.merge({}), TypeError);
  });
});

describe('createCountMinSketch — reset / snapshot', () => {
  test('reset clears counters and tracked keys', () => {
    const cms = createCountMinSketch({});
    cms.add('x', 5); cms.add('y', 3);
    cms.reset();
    assert.equal(cms.estimate('x'), 0);
    assert.equal(cms.snapshot().seenKeys, 0);
  });

  test('snapshot exposes config + defensive copy of counters', () => {
    const cms = createCountMinSketch({ width: 64, depth: 3 });
    cms.add('x');
    const s = cms.snapshot();
    assert.equal(s.width, 64);
    assert.equal(s.depth, 3);
    s.counters[0] = 999;
    assert.notEqual(cms.snapshot().counters[0], 999);
  });
});

describe('createCountMinSketch — saturation', () => {
  test('saturating add does not wrap Uint32', () => {
    const cms = createCountMinSketch({ width: 8, depth: 1 });
    cms.add('x', 0xffffffff);
    cms.add('x', 5);
    assert.equal(cms.estimate('x'), 0xffffffff);
  });
});
