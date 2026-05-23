'use strict';

/**
 * lease-mutex — mutual exclusion with a fixed-duration lease and an
 * auto-renew heartbeat. Designed for "exactly one worker performs
 * this task at a time" semantics where the holder might crash
 * silently — when the lease expires the lock auto-frees so a peer
 * can take over. Works in-process today; the same surface (acquire
 * / heartbeat / release) maps cleanly onto a Redis-backed
 * implementation later.
 *
 * Pairs with the existing redlock module (concurrency/redlock.js)
 * which is request-scoped; this one is task-scoped (long-running)
 * and explicitly handles holder death.
 *
 * Public API:
 *   const m = createLeaseMutex({ now? })
 *   const lock = await m.acquire(key, { ttlMs, holderId? })
 *     → { token, expiresAt }
 *     → throws LeaseHeldError if held by another live token
 *   m.heartbeat(key, token)              → { expiresAt } | throws
 *   m.release(key, token)                → boolean
 *   m.tryAcquire(key, { ttlMs, holderId? }) → lock | null
 *   m.peek(key)                          → snapshot | null
 *   m.snapshot()                         → registry summary
 *
 * Tokens are random 16-byte hex strings; only the holding token can
 * heartbeat or release. An expired-but-still-recorded lock is treated
 * as free on the next acquire/tryAcquire call.
 */

const { randomBytes } = require('node:crypto');

const DEFAULT_TTL_MS = 30_000;

class LeaseHeldError extends Error {
  constructor(key, holderId) {
    super(`lease-mutex: key "${key}" is held by holder ${holderId || '<anonymous>'}`);
    this.name = 'LeaseHeldError';
    this.code = 'LEASE_HELD';
  }
}

class LeaseInvalidError extends Error {
  constructor(key, reason) {
    super(`lease-mutex: invalid lease op on "${key}" (${reason})`);
    this.name = 'LeaseInvalidError';
    this.code = 'LEASE_INVALID';
    this.reason = reason;
  }
}

function createLeaseMutex(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, {token, holderId, expiresAt, acquiredAt}>} */
  const leases = new Map();
  let totalAcquires = 0;
  let totalRejects = 0;
  let totalReleases = 0;

  function isExpired(lease, t) { return !lease || lease.expiresAt <= t; }

  function newToken() { return randomBytes(16).toString('hex'); }

  function tryAcquire(key, { ttlMs = DEFAULT_TTL_MS, holderId = null } = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('lease-mutex: key required');
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : DEFAULT_TTL_MS;
    const t = now();
    const existing = leases.get(key);
    if (existing && !isExpired(existing, t)) {
      totalRejects += 1;
      return null;
    }
    const lease = {
      token: newToken(),
      holderId: holderId || null,
      expiresAt: t + ttl,
      acquiredAt: t,
      ttlMs: ttl,
    };
    leases.set(key, lease);
    totalAcquires += 1;
    return { token: lease.token, expiresAt: lease.expiresAt };
  }

  async function acquire(key, opts2 = {}) {
    const out = tryAcquire(key, opts2);
    if (!out) {
      const existing = leases.get(key);
      throw new LeaseHeldError(key, existing && existing.holderId);
    }
    return out;
  }

  function heartbeat(key, token, { ttlMs } = {}) {
    if (typeof key !== 'string' || !key) throw new TypeError('lease-mutex: key required');
    const t = now();
    const lease = leases.get(key);
    if (!lease) throw new LeaseInvalidError(key, 'no_lease');
    if (lease.token !== token) throw new LeaseInvalidError(key, 'wrong_token');
    if (isExpired(lease, t)) {
      leases.delete(key);
      throw new LeaseInvalidError(key, 'expired');
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : lease.ttlMs;
    lease.expiresAt = t + ttl;
    lease.ttlMs = ttl;
    return { expiresAt: lease.expiresAt };
  }

  function release(key, token) {
    const lease = leases.get(key);
    if (!lease) return false;
    if (lease.token !== token) return false;
    leases.delete(key);
    totalReleases += 1;
    return true;
  }

  function peek(key) {
    const lease = leases.get(key);
    if (!lease) return null;
    const t = now();
    if (isExpired(lease, t)) { leases.delete(key); return null; }
    return {
      key,
      holderId: lease.holderId,
      expiresAt: lease.expiresAt,
      acquiredAt: lease.acquiredAt,
      remainingMs: lease.expiresAt - t,
    };
  }

  function snapshot() {
    const t = now();
    let live = 0;
    for (const [k, l] of leases) {
      if (isExpired(l, t)) leases.delete(k);
      else live += 1;
    }
    return {
      live,
      totalAcquires,
      totalRejects,
      totalReleases,
    };
  }

  return { acquire, tryAcquire, heartbeat, release, peek, snapshot };
}

module.exports = {
  createLeaseMutex,
  LeaseHeldError,
  LeaseInvalidError,
  DEFAULT_TTL_MS,
};
