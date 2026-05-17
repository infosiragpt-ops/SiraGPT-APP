/**
 * Tests for services/web/rate-limiter.js — per-host token bucket +
 * exponential backoff with injectable clock.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  createRateLimiter,
  DEFAULT_CAPACITY,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_BACKOFF_MS,
} = require('../src/services/web/rate-limiter');

// Manual clock helper: makes time advance deterministic.
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (v) => { t = v; },
  };
}

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_CAPACITY = 10', () => {
    assert.equal(DEFAULT_CAPACITY, 10);
  });

  it('DEFAULT_WINDOW_MS = 60s', () => {
    assert.equal(DEFAULT_WINDOW_MS, 60_000);
  });

  it('DEFAULT_MAX_BACKOFF_MS = 5min', () => {
    assert.equal(DEFAULT_MAX_BACKOFF_MS, 300_000);
  });
});

// ── acquireDelay · token bucket ────────────────────────────────

describe('acquireDelay · token bucket', () => {
  it('first call on a new host fires immediately (full bucket)', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    const out = rl.acquireDelay('a.com');
    assert.equal(out.delay, 0);
    assert.equal(out.reason, 'ready');
  });

  it('depletes capacity over N calls', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, capacity: 3, windowMs: 60_000,
    });
    assert.equal(rl.acquireDelay('a').reason, 'ready');
    assert.equal(rl.acquireDelay('a').reason, 'ready');
    assert.equal(rl.acquireDelay('a').reason, 'ready');
    // 4th call: throttled.
    const fourth = rl.acquireDelay('a');
    assert.equal(fourth.reason, 'throttled');
    assert.ok(fourth.delay > 0);
  });

  it('refills tokens linearly over time', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, capacity: 10, windowMs: 60_000,
    });
    // Drain the bucket.
    for (let i = 0; i < 10; i++) rl.acquireDelay('a');
    assert.equal(rl.acquireDelay('a').reason, 'throttled');
    // Advance 6s → 6/60 of capacity = 1 token.
    clock.advance(6_000);
    const out = rl.acquireDelay('a');
    assert.equal(out.reason, 'ready');
  });

  it('caps refilled tokens at capacity', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, capacity: 5, windowMs: 60_000,
    });
    rl.acquireDelay('a');  // 5 → 4
    // Advance 1 hour → would refill to 64 capacity if uncapped.
    clock.advance(60 * 60_000);
    rl.acquireDelay('a');  // 5 (capped) → 4 again
    const snap = rl.snapshot();
    // After the second acquire, tokens should be ≤ 4 (just-acquired = 5 - 1).
    assert.ok(snap.a.tokens <= 4);
  });

  it('per-host buckets are independent', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, capacity: 2, windowMs: 60_000,
    });
    rl.acquireDelay('a.com');
    rl.acquireDelay('a.com');
    assert.equal(rl.acquireDelay('a.com').reason, 'throttled');
    // b.com still has full bucket.
    assert.equal(rl.acquireDelay('b.com').reason, 'ready');
  });

  it('throttled delay grows with deficit', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, capacity: 6, windowMs: 60_000,
    });
    for (let i = 0; i < 6; i++) rl.acquireDelay('a');
    const out = rl.acquireDelay('a');
    assert.ok(out.delay >= 5_000 && out.delay <= 12_000,
      `expected ~10s delay for 1-token deficit at 6/min, got ${out.delay}`);
  });
});

// ── acquireDelay · backoff ─────────────────────────────────────

describe('acquireDelay · backoff', () => {
  it('returns "backoff" when within backoffUntil window', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', { retryAfterMs: 5_000 });
    const out = rl.acquireDelay('a');
    assert.equal(out.reason, 'backoff');
    assert.ok(out.delay > 0 && out.delay <= 5_000);
  });

  it('returns "ready" once backoff has elapsed', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', { retryAfterMs: 1_000 });
    clock.advance(1_001);
    assert.equal(rl.acquireDelay('a').reason, 'ready');
  });
});

// ── recordFailure ──────────────────────────────────────────────

describe('recordFailure · multiplicative backoff', () => {
  it('first failure → 1000ms base', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    const out = rl.recordFailure('a', {});
    assert.equal(out.backoffMs, 1000);
  });

  it('second failure → doubles (2000ms)', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', {});
    const out = rl.recordFailure('a', {});
    assert.equal(out.backoffMs, 2000);
  });

  it('is5xx multiplies by 1.5', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', {});         // 1000
    const out = rl.recordFailure('a', { is5xx: true });
    assert.equal(out.backoffMs, Math.ceil(2000 * 1.5));  // 3000
  });

  it('isRateLimitHeader multiplies by 2 (more aggressive than 5xx)', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', {});  // 1000
    const out = rl.recordFailure('a', { isRateLimitHeader: true });
    assert.equal(out.backoffMs, 2000 * 2);  // 4000
  });

  it('caps at maxBackoffMs', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, maxBackoffMs: 5000,
    });
    for (let i = 0; i < 20; i++) rl.recordFailure('a', {});
    const snap = rl.snapshot();
    assert.equal(snap.a.backoffMs, 5000);
  });

  it('explicit retryAfterMs overrides multiplicative logic', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', {});  // 1000
    const out = rl.recordFailure('a', { retryAfterMs: 8000 });
    assert.equal(out.backoffMs, 8000);
  });

  it('retryAfterMs above maxBackoffMs is clamped', () => {
    const clock = makeClock();
    const rl = createRateLimiter({
      clock: clock.now, maxBackoffMs: 3000,
    });
    const out = rl.recordFailure('a', { retryAfterMs: 60_000 });
    assert.equal(out.backoffMs, 3000);
  });

  it('non-positive / non-finite retryAfterMs falls back to multiplicative', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    const a = rl.recordFailure('a', { retryAfterMs: 0 });
    assert.equal(a.backoffMs, 1000);
    const b = rl.recordFailure('a', { retryAfterMs: -5 });
    assert.equal(b.backoffMs, 2000);
    const c = rl.recordFailure('a', { retryAfterMs: NaN });
    assert.equal(c.backoffMs, 4000);
  });

  it('backoffUntil is now + backoffMs', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    const out = rl.recordFailure('a', { retryAfterMs: 2_500 });
    assert.equal(out.backoffUntil, clock.now() + 2_500);
  });
});

// ── recordSuccess ─────────────────────────────────────────────

describe('recordSuccess', () => {
  it('clears backoffMs + backoffUntil', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', { retryAfterMs: 5000 });
    rl.recordSuccess('a');
    const snap = rl.snapshot();
    assert.equal(snap.a.backoffMs, 0);
    assert.equal(snap.a.backoffUntil, 0);
  });

  it('subsequent failure restarts from 1000 base (not doubled)', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now });
    rl.recordFailure('a', {});
    rl.recordFailure('a', {});
    rl.recordSuccess('a');
    const out = rl.recordFailure('a', {});
    assert.equal(out.backoffMs, 1000);
  });
});

// ── snapshot ───────────────────────────────────────────────────

describe('snapshot', () => {
  it('returns {} for a fresh limiter', () => {
    const rl = createRateLimiter({ clock: () => 0 });
    assert.deepEqual(rl.snapshot(), {});
  });

  it('reports per-host token / backoff state', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now, capacity: 5, windowMs: 60_000 });
    rl.acquireDelay('a');
    rl.acquireDelay('a');
    rl.recordFailure('b', { retryAfterMs: 3_000 });
    const snap = rl.snapshot();
    assert.ok('a' in snap);
    assert.ok('b' in snap);
    // a has consumed 2 tokens from 5.
    assert.ok(Math.abs(snap.a.tokens - 3) < 0.01);
    assert.equal(snap.b.backoffMs, 3_000);
  });

  it('tokens rounded to 2 decimal places', () => {
    const clock = makeClock();
    const rl = createRateLimiter({ clock: clock.now, capacity: 10, windowMs: 1000 });
    rl.acquireDelay('a');  // tokens become 9 exactly
    const snap = rl.snapshot();
    // 9.000... → 9 (no decimal)
    assert.equal(snap.a.tokens, 9);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/web/rate-limiter');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'DEFAULT_CAPACITY', 'DEFAULT_MAX_BACKOFF_MS', 'DEFAULT_WINDOW_MS',
      'createRateLimiter',
    ]);
  });
});
