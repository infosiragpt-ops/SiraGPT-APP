'use strict';

/**
 * login-lockout — account-level brute-force throttle (improvement
 * cycle 17, Task 4).
 *
 * Existing protection: the per-IP+email sliding-window rate limit in
 * `rate-limit-auth.js` caps how fast a single client can iterate. That
 * defends the IP-side, not the account-side: a distributed credential
 * stuffing attack (one attempt per IP) trivially evades it.
 *
 * This utility adds a per-EMAIL counter. After N failed attempts in a
 * rolling window, the account is "locked" and login is rejected with
 * 423 (Locked) until the window expires.
 *
 * Storage: in-process Map. For multi-instance deploys, swap to the
 * existing Redis rate-limit-store. Kept minimal here so it's testable
 * without extra infra.
 */

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

class LoginLockout {
  constructor({ maxAttempts = DEFAULT_MAX_ATTEMPTS, windowMs = DEFAULT_WINDOW_MS } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map(); // key → number[] (timestamps of failures)
  }

  _key(email) {
    return String(email || '').trim().toLowerCase();
  }

  _prune(arr, now) {
    return arr.filter((t) => now - t < this.windowMs);
  }

  /**
   * isLocked(email) → { locked: boolean, retryAfterMs?: number, attempts: number }
   */
  isLocked(email, now = Date.now()) {
    const key = this._key(email);
    if (!key) return { locked: false, attempts: 0 };
    const pruned = this._prune(this.attempts.get(key) || [], now);
    this.attempts.set(key, pruned);
    if (pruned.length >= this.maxAttempts) {
      const oldest = pruned[0];
      return {
        locked: true,
        attempts: pruned.length,
        retryAfterMs: Math.max(0, this.windowMs - (now - oldest)),
      };
    }
    return { locked: false, attempts: pruned.length };
  }

  /**
   * recordFailure(email) → updated state after appending one failure.
   */
  recordFailure(email, now = Date.now()) {
    const key = this._key(email);
    if (!key) return { locked: false, attempts: 0 };
    const pruned = this._prune(this.attempts.get(key) || [], now);
    pruned.push(now);
    this.attempts.set(key, pruned);
    if (pruned.length >= this.maxAttempts) {
      return {
        locked: true,
        attempts: pruned.length,
        retryAfterMs: this.windowMs,
      };
    }
    return { locked: false, attempts: pruned.length };
  }

  /**
   * recordSuccess(email) — clears failure history on a successful login.
   */
  recordSuccess(email) {
    const key = this._key(email);
    if (key) this.attempts.delete(key);
  }

  reset() {
    this.attempts.clear();
  }
}

// Singleton for the auth route. Tests can construct their own instances.
const defaultLockout = new LoginLockout();

module.exports = {
  LoginLockout,
  defaultLockout,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
};
