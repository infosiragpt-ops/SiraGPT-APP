'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createJitteredBackoff,
  parseRetryAfter,
} = require('../src/services/ai-product-os/jittered-backoff');

describe('parseRetryAfter', () => {
  test('numeric seconds → ms', () => {
    assert.equal(parseRetryAfter(2), 2000);
    assert.equal(parseRetryAfter('5'), 5000);
    assert.equal(parseRetryAfter(0), 0);
  });
  test('HTTP-date → delta from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const fut = parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now);
    assert.equal(fut, 30_000);
  });
  test('past date → 0', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 0);
  });
  test('null / unparseable → null', () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter(''), null);
    assert.equal(parseRetryAfter('not a date'), null);
  });
});

describe('createJitteredBackoff — fixed strategy', () => {
  test('fixed delays are exact base * 2^attempt', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 10_000 });
    assert.equal(s.next({ attempt: 0 }), 100);
    assert.equal(s.next({ attempt: 1 }), 200);
    assert.equal(s.next({ attempt: 2 }), 400);
    assert.equal(s.next({ attempt: 3 }), 800);
  });

  test('fixed delays are clamped at maxMs', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 500 });
    assert.equal(s.next({ attempt: 10 }), 500);
  });
});

describe('createJitteredBackoff — full jitter', () => {
  test('always within [0, base*2^attempt] capped at maxMs', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'full', maxMs: 10_000, rng: () => 0.9 });
    for (let a = 0; a < 8; a++) {
      const d = s.next({ attempt: a });
      assert.ok(d >= 0);
      assert.ok(d <= Math.min(10_000, 100 * Math.pow(2, a)));
    }
  });

  test('rng=0 → 0 delay; rng→1 → near-cap delay', () => {
    const lo = createJitteredBackoff({ baseMs: 100, strategy: 'full', maxMs: 10_000, rng: () => 0 });
    const hi = createJitteredBackoff({ baseMs: 100, strategy: 'full', maxMs: 10_000, rng: () => 0.9999 });
    assert.equal(lo.next({ attempt: 3 }), 0);
    const h = hi.next({ attempt: 3 }); // ≤ 800
    assert.ok(h <= 800 && h > 700);
  });
});

describe('createJitteredBackoff — decorrelated jitter', () => {
  test('decorrelated stays within [base, prev*3] capped at maxMs', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'decorrelated', maxMs: 10_000, rng: () => 0.5 });
    // Manual walk: prev starts at base=100. First call: lo=100, hi=min(max, 300) = 300.
    // delay = 100 + 0.5*200 = 200. prev=200.
    assert.equal(s.next({}), 200);
    // Next: lo=100, hi=600. delay = 100 + 0.5*500 = 350. prev=350.
    assert.equal(s.next({}), 350);
  });

  test('reset returns prev to base', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'decorrelated', maxMs: 10_000, rng: () => 0.5 });
    s.next({}); s.next({}); s.next({});
    s.reset();
    assert.equal(s.next({}), 200);
  });
});

describe('createJitteredBackoff — Retry-After hint', () => {
  test('honors numeric Retry-After regardless of strategy', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 10_000 });
    assert.equal(s.next({ attempt: 5, retryAfter: 7 }), 7000);
  });

  test('clamps Retry-After to maxMs', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 500 });
    assert.equal(s.next({ attempt: 0, retryAfter: 60 }), 500);
  });

  test('ignores unparseable Retry-After', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 10_000 });
    assert.equal(s.next({ attempt: 0, retryAfter: 'gibberish' }), 100);
  });

  test('numeric retryAfter is seconds (HTTP semantics)', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed', maxMs: 60_000 });
    assert.equal(s.next({ attempt: 0, retryAfter: 1.5 }), 1500);
  });
});

describe('createJitteredBackoff — guards', () => {
  test('bad attempt floors to 0', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'fixed' });
    assert.equal(s.next({ attempt: -3 }), 100);
    assert.equal(s.next({ attempt: NaN }), 100);
  });

  test('unknown strategy falls back to full', () => {
    const s = createJitteredBackoff({ baseMs: 100, strategy: 'banana', maxMs: 1000, rng: () => 0 });
    assert.equal(s.next({ attempt: 2 }), 0);
  });

  test('exposes config for inspection', () => {
    const s = createJitteredBackoff({ baseMs: 50, maxMs: 1000, strategy: 'fixed' });
    assert.equal(s.baseMs, 50);
    assert.equal(s.maxMs, 1000);
    assert.equal(s.strategy, 'fixed');
  });
});
