'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createP2Quantile, createMultiQuantile } = require('../src/services/observability/p2-quantile');

function exactQuantile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function seededRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createP2Quantile — construction', () => {
  test('rejects p outside (0,1)', () => {
    assert.throws(() => createP2Quantile(0), TypeError);
    assert.throws(() => createP2Quantile(1), TypeError);
    assert.throws(() => createP2Quantile(-0.1), TypeError);
    assert.throws(() => createP2Quantile('high'), TypeError);
  });

  test('value() is null until 5 samples observed', () => {
    const q = createP2Quantile(0.95);
    for (let i = 0; i < 4; i++) {
      q.observe(i);
      assert.equal(q.value(), null);
    }
    q.observe(5);
    assert.notEqual(q.value(), null);
  });
});

describe('createP2Quantile — accuracy', () => {
  test('p50 of uniform [0,1) within ~5% of exact', () => {
    const q = createP2Quantile(0.5);
    const rng = seededRng(7);
    const samples = [];
    for (let i = 0; i < 5000; i++) { const v = rng(); samples.push(v); q.observe(v); }
    const exact = exactQuantile(samples, 0.5);
    const est = q.value();
    assert.ok(Math.abs(est - exact) < 0.05, `est=${est} exact=${exact}`);
  });

  test('p95 of skewed exponential within ~10% of exact', () => {
    const q = createP2Quantile(0.95);
    const rng = seededRng(99);
    const samples = [];
    for (let i = 0; i < 10_000; i++) {
      const u = Math.max(rng(), 1e-9);
      const v = -Math.log(u); // exponential(1)
      samples.push(v); q.observe(v);
    }
    const exact = exactQuantile(samples, 0.95);
    const est = q.value();
    const rel = Math.abs(est - exact) / exact;
    assert.ok(rel < 0.1, `relative error ${rel.toFixed(3)} too large (est=${est}, exact=${exact})`);
  });

  test('p99 estimator stays within 15% on heavy-tail samples', () => {
    const q = createP2Quantile(0.99);
    const rng = seededRng(42);
    const samples = [];
    for (let i = 0; i < 20_000; i++) {
      // pareto-ish with mostly small + a few big
      const v = 1 / Math.pow(rng(), 0.5);
      samples.push(v); q.observe(v);
    }
    const exact = exactQuantile(samples, 0.99);
    const est = q.value();
    const rel = Math.abs(est - exact) / exact;
    assert.ok(rel < 0.15, `relative error ${rel.toFixed(3)} too large (est=${est}, exact=${exact})`);
  });
});

describe('createP2Quantile — robustness', () => {
  test('NaN / non-number observations are dropped', () => {
    const q = createP2Quantile(0.5);
    q.observe(NaN); q.observe(undefined); q.observe('oops');
    for (let i = 1; i <= 5; i++) q.observe(i);
    assert.equal(q.count(), 5);
    assert.notEqual(q.value(), null);
  });

  test('snapshot includes p, count, value, markers', () => {
    const q = createP2Quantile(0.9);
    for (let i = 1; i <= 6; i++) q.observe(i);
    const s = q.snapshot();
    assert.equal(s.p, 0.9);
    assert.equal(s.count, 6);
    assert.equal(s.markers.length, 5);
    assert.notEqual(s.value, null);
  });
});

describe('createMultiQuantile', () => {
  test('observe fans out to all quantiles', () => {
    const m = createMultiQuantile([0.5, 0.95]);
    for (let i = 1; i <= 100; i++) m.observe(i);
    const v = m.values();
    assert.notEqual(v['0.5'], null);
    assert.notEqual(v['0.95'], null);
    // 0.5 should be roughly 50, 0.95 roughly 95.
    assert.ok(Math.abs(v['0.5'] - 50) < 10);
    assert.ok(Math.abs(v['0.95'] - 95) < 10);
  });

  test('rejects empty ps array', () => {
    assert.throws(() => createMultiQuantile([]), TypeError);
  });

  test('count reflects underlying estimators', () => {
    const m = createMultiQuantile([0.5, 0.99]);
    for (let i = 0; i < 7; i++) m.observe(i);
    assert.equal(m.count(), 7);
  });
});
