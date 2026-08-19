'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createSlidingCounter } = require('../src/services/observability/sliding-counter');

function mk(overrides = {}) {
  let t = 0;
  const c = createSlidingCounter({ windowSec: 10, bucketSec: 1, now: () => t, ...overrides });
  return { c, advance: (s) => { t += s; }, setT: (v) => { t = v; } };
}

describe('createSlidingCounter — basic', () => {
  test('records sum to current bucket', () => {
    const { c } = mk();
    c.record(); c.record(); c.record(2);
    assert.equal(c.sum(), 4);
  });

  test('peak reflects highest single bucket', () => {
    const { c, advance } = mk();
    c.record(5);
    advance(2);
    c.record(2);
    assert.equal(c.peak(), 5);
  });

  test('avgPerBucket = sum / buckets', () => {
    const { c } = mk({ windowSec: 4, bucketSec: 1 });
    c.record(8);
    assert.equal(c.avgPerBucket(), 2);
  });

  test('non-finite record is no-op', () => {
    const { c } = mk();
    c.record(NaN); c.record('x');
    assert.equal(c.sum(), 0);
  });
});

describe('createSlidingCounter — window aging', () => {
  test('events past window age out', () => {
    const { c, advance } = mk({ windowSec: 5 });
    c.record(10);
    advance(10);
    assert.equal(c.sum(), 0);
  });

  test('partial age-out: drops only old buckets', () => {
    const { c, advance } = mk({ windowSec: 5 });
    c.record(5);
    advance(2);
    c.record(3);
    advance(2);
    assert.equal(c.sum(), 8);
    advance(2); // t=6: window is [2,6]; the +5 at t=0 is now out, +3 at t=2 still in
    assert.equal(c.sum(), 3);
  });

  test('long idle clears entire ring', () => {
    const { c, advance } = mk({ windowSec: 3 });
    c.record(1);
    advance(60);
    assert.equal(c.sum(), 0);
  });
});

describe('createSlidingCounter — config + lifecycle', () => {
  test('windowSec must divide bucketSec', () => {
    assert.throws(() => createSlidingCounter({ windowSec: 7, bucketSec: 3 }), TypeError);
  });

  test('snapshot fields', () => {
    const { c } = mk({ windowSec: 6, bucketSec: 2 });
    c.record(4);
    const s = c.snapshot();
    assert.equal(s.windowSec, 6);
    assert.equal(s.bucketSec, 2);
    assert.equal(s.buckets, 3);
    assert.equal(s.sum, 4);
  });

  test('reset clears + restarts state', () => {
    const { c } = mk();
    c.record(5);
    c.reset();
    assert.equal(c.sum(), 0);
  });
});
