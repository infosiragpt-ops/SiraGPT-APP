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
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new TypeError('LoginLockout: maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError('LoginLockout: windowMs must be a positive number');
    }
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map(); // key → number[] (timestamps of failures)
  }

  _key(email) {
    return String(email || '').trim().toLowerCase();
  }

  _prune(arr, now) {
    return arr
      .filter((t) => Number.isFinite(t) && now - t >= 0 && now - t < this.windowMs)
      .sort((a, b) => a - b);
  }

  _store(key, arr) {
    if (!arr.length) {
      this.attempts.delete(key);
      return;
    }
    this.attempts.set(key, arr.slice(-this.maxAttempts));
  }

  _state(arr, now) {
    const attempts = arr.length;
    const remaining = Math.max(0, this.maxAttempts - attempts);
    if (attempts >= this.maxAttempts) {
      const oldest = arr[0];
      const retryAfterMs = Math.max(0, this.windowMs - (now - oldest));
      return {
        locked: true,
        attempts,
        remaining,
        retryAfterMs,
        lockedUntil: new Date(now + retryAfterMs).toISOString(),
      };
    }
    return { locked: false, attempts, remaining };
  }

  /**
   * isLocked(email) → { locked: boolean, retryAfterMs?: number, attempts: number }
   */
  isLocked(email, now = Date.now()) {
    const key = this._key(email);
    if (!key) return { locked: false, attempts: 0 };
    const pruned = this._prune(this.attempts.get(key) || [], now);
    const capped = pruned.slice(-this.maxAttempts);
    this._store(key, capped);
    return this._state(capped, now);
  }

  /**
   * recordFailure(email) → updated state after appending one failure.
   */
  recordFailure(email, now = Date.now()) {
    const key = this._key(email);
    if (!key) return { locked: false, attempts: 0 };
    const pruned = this._prune(this.attempts.get(key) || [], now);
    pruned.push(now);
    this._store(key, pruned);
    return this._state(pruned.slice(-this.maxAttempts), now);
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

  size() {
    return this.attempts.size;
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
