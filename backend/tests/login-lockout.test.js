/**
 * login-lockout — per-account brute-force throttle. Pins the rolling
 * window semantics and the success-clears-history contract.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { LoginLockout } = require('../src/utils/login-lockout');

describe('LoginLockout — basic counting', () => {
  test('locks after N failures within window', () => {
    const lo = new LoginLockout({ maxAttempts: 3, windowMs: 60_000 });
    lo.recordFailure('a@b.com');
    lo.recordFailure('a@b.com');
    assert.equal(lo.isLocked('a@b.com').locked, false);
    lo.recordFailure('a@b.com');
    const state = lo.isLocked('a@b.com');
    assert.equal(state.locked, true);
    assert.equal(state.attempts, 3);
    assert.equal(state.remaining, 0);
    assert.ok(state.retryAfterMs > 0);
    assert.ok(Date.parse(state.lockedUntil) >= Date.now());
  });

  test('per-email scoping (one account locking does not affect others)', () => {
    const lo = new LoginLockout({ maxAttempts: 2, windowMs: 60_000 });
    lo.recordFailure('a@b.com');
    lo.recordFailure('a@b.com');
    assert.equal(lo.isLocked('a@b.com').locked, true);
    assert.equal(lo.isLocked('other@b.com').locked, false);
  });

  test('case + whitespace-insensitive key', () => {
    const lo = new LoginLockout({ maxAttempts: 1, windowMs: 60_000 });
    lo.recordFailure('  A@B.com ');
    assert.equal(lo.isLocked('a@b.com').locked, true);
  });

  test('constructor rejects invalid limits', () => {
    assert.throws(() => new LoginLockout({ maxAttempts: 0 }), TypeError);
    assert.throws(() => new LoginLockout({ maxAttempts: 1.5 }), TypeError);
    assert.throws(() => new LoginLockout({ windowMs: 0 }), TypeError);
  });
});

describe('LoginLockout — window expiry', () => {
  test('attempts older than windowMs are pruned', () => {
    const lo = new LoginLockout({ maxAttempts: 2, windowMs: 1_000 });
    const t0 = 1_000_000;
    lo.recordFailure('a@b.com', t0);
    lo.recordFailure('a@b.com', t0);
    assert.equal(lo.isLocked('a@b.com', t0).locked, true);
    // 2 seconds later — entries expired.
    assert.equal(lo.isLocked('a@b.com', t0 + 2_000).locked, false);
    assert.equal(lo.size(), 0, 'expired empty buckets are removed');
  });

  test('retryAfterMs is based on oldest live failure, not a fresh full window', () => {
    const lo = new LoginLockout({ maxAttempts: 3, windowMs: 1_000 });
    lo.recordFailure('a@b.com', 1_000);
    lo.recordFailure('a@b.com', 1_300);
    const state = lo.recordFailure('a@b.com', 1_900);
    assert.equal(state.locked, true);
    assert.equal(state.retryAfterMs, 100);
  });
});

describe('LoginLockout — success resets', () => {
  test('recordSuccess clears history', () => {
    const lo = new LoginLockout({ maxAttempts: 3, windowMs: 60_000 });
    lo.recordFailure('a@b.com');
    lo.recordFailure('a@b.com');
    lo.recordSuccess('a@b.com');
    assert.equal(lo.isLocked('a@b.com').attempts, 0);
    assert.equal(lo.size(), 0);
  });
});

describe('LoginLockout — defaults match task spec (10 attempts / 15 min)', () => {
  test('defaults align with the cycle-17 spec', () => {
    const lo = new LoginLockout();
    assert.equal(lo.maxAttempts, 10);
    assert.equal(lo.windowMs, 15 * 60 * 1000);
  });
});
