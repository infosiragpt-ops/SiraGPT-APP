'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createEwmaTracker, DEFAULT_ALPHA } = require('../src/services/observability/ewma-tracker');

describe('createEwmaTracker — basic', () => {
  test('initial state has zero count + zero stats', () => {
    const t = createEwmaTracker({});
    assert.equal(t.count(), 0);
    assert.equal(t.mean(), 0);
    assert.equal(t.stddev(), 0);
  });

  test('first observation seeds mean exactly', () => {
    const t = createEwmaTracker({});
    t.observe(100);
    assert.equal(t.mean(), 100);
    assert.equal(t.variance(), 0);
    assert.equal(t.count(), 1);
  });

  test('non-finite values are dropped', () => {
    const t = createEwmaTracker({});
    t.observe(NaN); t.observe(Infinity); t.observe('x');
    assert.equal(t.count(), 0);
  });
});

describe('createEwmaTracker — convergence', () => {
  test('mean converges toward steady-state value', () => {
    const t = createEwmaTracker({ alpha: 0.2 });
    for (let i = 0; i < 200; i++) t.observe(50);
    assert.ok(Math.abs(t.mean() - 50) < 0.01);
  });

  test('variance shrinks toward 0 on constant stream', () => {
    const t = createEwmaTracker({ alpha: 0.3 });
    t.observe(10); // seed
    for (let i = 0; i < 100; i++) t.observe(10);
    assert.ok(t.variance() < 0.01);
  });

  test('higher alpha reacts faster to a step change', () => {
    const slow = createEwmaTracker({ alpha: 0.01 });
    const fast = createEwmaTracker({ alpha: 0.5 });
    for (let i = 0; i < 50; i++) { slow.observe(10); fast.observe(10); }
    for (let i = 0; i < 5; i++) { slow.observe(100); fast.observe(100); }
    assert.ok(fast.mean() > slow.mean(), `slow=${slow.mean()} fast=${fast.mean()}`);
  });
});

describe('createEwmaTracker — variance / stddev', () => {
  test('variance grows when observations vary', () => {
    const t = createEwmaTracker({ alpha: 0.3 });
    [10, 20, 5, 15, 25, 1, 30].forEach((v) => t.observe(v));
    assert.ok(t.variance() > 0);
    assert.ok(t.stddev() > 0);
  });

  test('stddev = sqrt(variance)', () => {
    const t = createEwmaTracker({});
    [10, 5, 20, 8].forEach((v) => t.observe(v));
    assert.ok(Math.abs(t.stddev() - Math.sqrt(t.variance())) < 1e-9);
  });
});

describe('createEwmaTracker — adaptive deadline', () => {
  test('returns mean + k*stddev under noise', () => {
    const t = createEwmaTracker({ alpha: 0.3 });
    for (const v of [100, 110, 95, 105, 120, 90, 100]) t.observe(v);
    const d2 = t.adaptiveDeadline(2);
    const expected = t.mean() + 2 * t.stddev();
    assert.ok(Math.abs(d2 - expected) < 1e-9);
  });

  test('floor and ceil clamp the result', () => {
    const t = createEwmaTracker({});
    for (let i = 0; i < 5; i++) t.observe(50);
    const d = t.adaptiveDeadline(0, 100, 200); // mean=50 → floored to 100
    assert.equal(d, 100);
    // Make stddev > 0 so a high k actually pushes past the ceil.
    const t2 = createEwmaTracker({ alpha: 0.3 });
    [10, 50, 90, 30, 70].forEach((v) => t2.observe(v));
    const dCap = t2.adaptiveDeadline(1000, 0, 60);
    assert.equal(dCap, 60);
  });

  test('zero-count returns clamped 0', () => {
    const t = createEwmaTracker({});
    assert.equal(t.adaptiveDeadline(3, 50, 1000), 50);
  });
});

describe('createEwmaTracker — lifecycle', () => {
  test('reset returns to zero state', () => {
    const t = createEwmaTracker({});
    [1, 2, 3].forEach((v) => t.observe(v));
    t.reset();
    assert.equal(t.count(), 0);
    assert.equal(t.mean(), 0);
  });

  test('snapshot exposes mean/variance/stddev/count/alpha', () => {
    const t = createEwmaTracker({ alpha: 0.2 });
    t.observe(7);
    const s = t.snapshot();
    assert.equal(s.alpha, 0.2);
    assert.equal(s.count, 1);
    assert.equal(s.mean, 7);
  });
});

describe('createEwmaTracker — defaults', () => {
  test('default alpha is 0.1', () => {
    assert.equal(DEFAULT_ALPHA, 0.1);
    const t = createEwmaTracker({});
    assert.equal(t.snapshot().alpha, 0.1);
  });

  test('out-of-range alpha falls back to default', () => {
    const t = createEwmaTracker({ alpha: 0 });
    assert.equal(t.snapshot().alpha, 0.1);
    const t2 = createEwmaTracker({ alpha: 5 });
    assert.equal(t2.snapshot().alpha, 0.1);
  });
});
