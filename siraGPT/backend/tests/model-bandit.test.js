'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createModelBandit,
  sampleBeta,
} = require('../src/services/ai-product-os/model-bandit');

function seededRng(seed = 123456789) {
  // mulberry32
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sampleBeta', () => {
  test('produces values in (0,1)', () => {
    const rng = seededRng();
    for (let i = 0; i < 100; i++) {
      const x = sampleBeta(2, 5, rng);
      assert.ok(x > 0 && x < 1);
    }
  });

  test('mean of many samples approximates alpha/(alpha+beta)', () => {
    const rng = seededRng(42);
    let s = 0; const N = 2000;
    for (let i = 0; i < N; i++) s += sampleBeta(8, 2, rng);
    const empirical = s / N;
    assert.ok(Math.abs(empirical - 0.8) < 0.05, `mean ${empirical} ~ 0.8`);
  });
});

describe('createModelBandit — construction', () => {
  test('rejects empty arms', () => {
    assert.throws(() => createModelBandit({}), TypeError);
    assert.throws(() => createModelBandit({ arms: [] }), TypeError);
  });

  test('exposes arms()', () => {
    const b = createModelBandit({ arms: ['a', 'b'] });
    assert.deepEqual(b.arms(), ['a', 'b']);
  });
});

describe('createModelBandit — select / report', () => {
  test('without feedback, select picks every arm sometimes', () => {
    const rng = seededRng(7);
    const b = createModelBandit({ arms: ['a', 'b', 'c'], rng });
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(b.select());
    assert.equal(seen.size, 3);
  });

  test('after enough wins, the winner is selected far more often', () => {
    const rng = seededRng(13);
    const b = createModelBandit({ arms: ['x', 'y'], rng });
    // Arm y wins much more often.
    for (let i = 0; i < 200; i++) {
      b.report('ctx', 'x', i % 5 === 0);
      b.report('ctx', 'y', true);
    }
    const counts = { x: 0, y: 0 };
    for (let i = 0; i < 1000; i++) counts[b.select('ctx')] += 1;
    assert.ok(counts.y > counts.x * 3, `y=${counts.y} x=${counts.x}`);
  });

  test('reports for unknown arm return false', () => {
    const b = createModelBandit({ arms: ['a'] });
    assert.equal(b.report('ctx', 'z', true), false);
  });
});

describe('createModelBandit — context partitioning', () => {
  test('different contexts learn independently', () => {
    const b = createModelBandit({ arms: ['p', 'q'], rng: seededRng(99) });
    for (let i = 0; i < 100; i++) {
      b.report('A', 'p', true);   // p wins in A
      b.report('B', 'q', true);   // q wins in B
    }
    const snap = b.snapshot();
    assert.ok(snap.A.p.mean > snap.A.q.mean);
    assert.ok(snap.B.q.mean > snap.B.p.mean);
  });

  test('snapshot(ctx) returns null for unknown context', () => {
    const b = createModelBandit({ arms: ['a'] });
    assert.equal(b.snapshot('never'), null);
  });
});

describe('createModelBandit — decay (halfLifeReports)', () => {
  test('half-life decays old wins toward prior', () => {
    const b = createModelBandit({ arms: ['a', 'b'], halfLifeReports: 10, rng: seededRng(2) });
    // Without decay, 100 successive wins would push alpha to 101.
    // With halfLife=10 the decay fires repeatedly and bounds alpha
    // far below that ceiling.
    for (let i = 0; i < 100; i++) b.report('c', 'a', true);
    const a = b.snapshot('c').a.alpha;
    assert.ok(a < 30, `expected decay to bound alpha, got ${a}`);
  });
});

describe('createModelBandit — reset', () => {
  test('reset(ctx) wipes that context only', () => {
    const b = createModelBandit({ arms: ['a'] });
    b.report('A', 'a', true);
    b.report('B', 'a', true);
    b.reset('A');
    assert.equal(b.snapshot('A'), null);
    assert.ok(b.snapshot('B'));
  });

  test('reset() wipes everything', () => {
    const b = createModelBandit({ arms: ['a'] });
    b.report('A', 'a', true);
    b.reset();
    assert.deepEqual(b.snapshot(), {});
  });
});

describe('createModelBandit — snapshot includes mean', () => {
  test('mean = alpha/(alpha+beta)', () => {
    const b = createModelBandit({ arms: ['a'] });
    b.report('c', 'a', true);
    b.report('c', 'a', true);
    b.report('c', 'a', false);
    const s = b.snapshot('c').a;
    const expected = s.alpha / (s.alpha + s.beta);
    assert.ok(Math.abs(s.mean - expected) < 1e-9);
  });
});
