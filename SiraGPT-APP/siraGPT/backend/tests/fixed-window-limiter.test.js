'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createFixedWindowLimiter } = require('../src/services/rate-limit/fixed-window');

describe('createFixedWindowLimiter — construction', () => {
  test('rejects non-positive limit', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 0, windowMs: 1000 }), TypeError);
    assert.throws(() => createFixedWindowLimiter({ limit: 1.5, windowMs: 1000 }), TypeError);
  });
  test('rejects non-positive windowMs', () => {
    assert.throws(() => createFixedWindowLimiter({ limit: 5, windowMs: 0 }), TypeError);
  });
});

describe('check — basic accounting', () => {
  test('allows up to limit, denies after', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({ limit: 3, windowMs: 1000, now: () => t });
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, true);
    const last = lim.check('a');
    assert.equal(last.allowed, true);
    assert.equal(last.remaining, 0);
    const blocked = lim.check('a');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.equal(blocked.count, 3);
  });

  test('per-key isolation', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, false);
    assert.equal(lim.check('b').allowed, true);
  });
});

describe('window rollover', () => {
  test('crossing boundary resets count', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, false);
    t = 1500; // next window
    const after = lim.check('a');
    assert.equal(after.allowed, true);
    assert.equal(after.count, 1);
  });

  test('resetAt aligns to window boundary', () => {
    let t = 250; // partway into first window
    const lim = createFixedWindowLimiter({ limit: 5, windowMs: 1000, now: () => t });
    const r = lim.check('a');
    assert.equal(r.resetAt, 1000);
  });
});

describe('reset', () => {
  test('reset(key) clears single key', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    lim.check('a');
    assert.equal(lim.check('a').allowed, false);
    lim.reset('a');
    assert.equal(lim.check('a').allowed, true);
  });

  test('reset() clears all', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({ limit: 1, windowMs: 1000, now: () => t });
    lim.check('a'); lim.check('b'); lim.check('c');
    assert.equal(lim.size(), 3);
    lim.reset();
    assert.equal(lim.size(), 0);
  });
});

describe('lazy GC', () => {
  test('cold keys evicted after gcEveryHits triggers', () => {
    let t = 0;
    const lim = createFixedWindowLimiter({
      limit: 1000, windowMs: 1000, now: () => t, gcEveryHits: 5,
    });
    // Populate two cold keys in window 0
    lim.check('cold1'); lim.check('cold2');
    // Advance to window 5 — cold keys are stale
    t = 5000;
    // Hit a fresh key 5 times to trigger GC sweep
    for (let i = 0; i < 5; i++) lim.check('fresh');
    assert.equal(lim.size(), 1, 'cold keys should be evicted');
  });
});

describe('input validation', () => {
  test('rejects non-string / empty key', () => {
    const lim = createFixedWindowLimiter({ limit: 1, windowMs: 1000 });
    assert.throws(() => lim.check(''), TypeError);
    assert.throws(() => lim.check(123), TypeError);
  });
});

describe('snapshot', () => {
  test('reports current state', () => {
    const lim = createFixedWindowLimiter({ limit: 10, windowMs: 60000 });
    lim.check('a'); lim.check('b');
    const s = lim.snapshot();
    assert.equal(s.limit, 10);
    assert.equal(s.windowMs, 60000);
    assert.equal(s.size, 2);
  });
});
