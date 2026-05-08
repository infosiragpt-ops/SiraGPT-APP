'use strict';

/**
 * redlock — small distributed-lock primitive built on the
 * single-instance variant of the Redlock algorithm. It is the
 * minimum needed to give a multi-process Express deployment
 * single-flight semantics behind shared keys: e.g. the idempotency
 * middleware coordinating a request that arrives on two replicas at
 * the same time.
 *
 * What is supported:
 *   - acquire(resource, ttlMs) → handle | null  (SET NX PX)
 *   - handle.release()         — safe release (only the owner deletes)
 *   - handle.extend(ttlMs)     — best-effort extension via PEXPIRE
 *   - using(resource, ttlMs, fn) — acquire / run / release wrapper
 *
 * What is NOT supported (call-out, not omission-by-accident):
 *   - Multi-master Redlock (the N≥3 quorum variant). Most production
 *     SiraGPT deployments run one Redis; the multi-master variant
 *     adds operational weight that is not worth its safety margin
 *     here. The single-instance variant is documented by Redis as
 *     "good enough for the vast majority of use-cases" and matches
 *     how the idempotency middleware already uses Redis SET NX PX.
 *   - Re-entrancy. A second acquire from the same process on the
 *     same resource will simply fail-fast until the first releases.
 *
 * Safety properties this primitive guarantees:
 *   1. Mutual exclusion within the TTL window: SET NX PX is atomic.
 *   2. Owner-scoped release: a caller can only delete the key if its
 *      fencing token matches the value stored. A caller whose lock
 *      already expired and was re-acquired by somebody else will NOT
 *      delete the new owner's lock.
 *   3. Liveness via TTL: even if a process crashes mid-critical-
 *      section, the lock auto-expires.
 *   4. Graceful degradation: if Redis is unreachable, acquire()
 *      returns null. Callers decide whether to fail-closed (reject
 *      the request) or fail-open (proceed without the lock) — this
 *      module does NOT silently downgrade like the idempotency
 *      middleware does, because for a generic lock primitive the
 *      caller's risk model differs.
 *
 * Storage backends: an `ioredis`-shaped client when REDIS_URL is set,
 * otherwise an in-memory adapter useful for tests and single-instance
 * dev. The in-memory adapter implements the same SET NX PX surface
 * that the Redis backend uses, so the Redlock body itself is backend-
 * agnostic.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_RETRY_COUNT = 0;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_RETRY_JITTER_MS = 50;
const DEFAULT_CLOCK_DRIFT_FACTOR = 0.01;
const DEFAULT_PREFIX = 'lock:';
const MIN_TTL_MS = 10;

// Lua: delete only when the value matches the caller's token. This is
// the Redlock-canonical "owner-scoped delete" — without it, a caller
// whose lock expired could still delete a freshly-acquired lock that
// happens to be on the same key.
const RELEASE_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

// Same shape, applied to PEXPIRE: only extend if we still own the
// lock. Returns 1 on success, 0 if we no longer own it.
const EXTEND_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end';

class RedlockError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RedlockError';
    this.code = code || 'REDLOCK_ERROR';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken() {
  // 20 bytes is plenty for collision resistance across the lifetime
  // of a TTL-bounded key. Hex output keeps it printable for logs.
  return crypto.randomBytes(20).toString('hex');
}

function clampTtl(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < MIN_TTL_MS) return DEFAULT_TTL_MS;
  return Math.floor(n);
}

/**
 * createMemoryLockBackend — single-process adapter that mimics the
 * subset of `ioredis` used by the Redlock body. Only useful when one
 * process needs the API surface (tests, single-replica dev). It does
 * NOT provide cross-process coordination — that is the whole point
 * of Redis here. Tests assert this explicitly so a future caller
 * does not accidentally rely on it for multi-process safety.
 */
function createMemoryLockBackend({ now = () => Date.now() } = {}) {
  const map = new Map();
  function gc() {
    const cutoff = now();
    for (const [k, v] of map) {
      if (v.expiresAt <= cutoff) map.delete(k);
    }
  }
  return {
    mode: 'memory',
    async set(key, value, ...args) {
      gc();
      let ttlMs = null;
      let nx = false;
      for (let i = 0; i < args.length; i += 1) {
        const flag = String(args[i]).toUpperCase();
        if (flag === 'PX') { ttlMs = Number(args[i + 1]); i += 1; }
        else if (flag === 'EX') { ttlMs = Number(args[i + 1]) * 1000; i += 1; }
        else if (flag === 'NX') { nx = true; }
      }
      if (nx && map.has(key) && map.get(key).expiresAt > now()) return null;
      const expiresAt = ttlMs ? now() + ttlMs : Infinity;
      map.set(key, { value, expiresAt });
      return 'OK';
    },
    async get(key) {
      gc();
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { map.delete(key); return null; }
      return entry.value;
    },
    async del(key) {
      const had = map.delete(key);
      return had ? 1 : 0;
    },
    async pexpire(key, ttlMs) {
      const entry = map.get(key);
      if (!entry) return 0;
      entry.expiresAt = now() + Number(ttlMs);
      return 1;
    },
    async eval(script, numKeys, ...rest) {
      const keys = rest.slice(0, numKeys);
      const argv = rest.slice(numKeys);
      if (script === RELEASE_SCRIPT) {
        const current = await this.get(keys[0]);
        if (current === argv[0]) return this.del(keys[0]);
        return 0;
      }
      if (script === EXTEND_SCRIPT) {
        const current = await this.get(keys[0]);
        if (current === argv[0]) return this.pexpire(keys[0], Number(argv[1]));
        return 0;
      }
      throw new RedlockError('unsupported script in memory backend', 'REDLOCK_UNSUPPORTED');
    },
    _size() { return map.size; },
    _peek(key) { return map.get(key) || null; },
  };
}

/**
 * Lock handle returned by acquire(). Two operations:
 *   - release(): deletes the key only if we still own it.
 *   - extend(newTtlMs): pushes the deadline forward, only if owned.
 *
 * `expiresAt` is the wall-clock deadline AFTER subtracting the
 * configured clock-drift margin. A caller comparing Date.now() to
 * `expiresAt` is comparing against the conservative deadline, not
 * the raw TTL the server is enforcing. That gives the caller a
 * built-in safety margin for "should I bail out before the lock
 * expires?" decisions.
 */
class LockHandle {
  constructor({ redlock, resource, key, token, ttlMs, expiresAt }) {
    this._redlock = redlock;
    this.resource = resource;
    this.key = key;
    this.token = token;
    this.ttlMs = ttlMs;
    this.expiresAt = expiresAt;
    this._released = false;
  }

  isExpired(now = Date.now()) {
    return now >= this.expiresAt;
  }

  async release() {
    if (this._released) return false;
    this._released = true;
    return this._redlock._releaseHandle(this);
  }

  async extend(newTtlMs) {
    if (this._released) {
      throw new RedlockError('cannot extend a released lock', 'REDLOCK_RELEASED');
    }
    return this._redlock._extendHandle(this, newTtlMs);
  }
}

class Redlock {
  constructor(options = {}) {
    this.client = options.client || createMemoryLockBackend();
    this.prefix = String(options.prefix || DEFAULT_PREFIX);
    this.retryCount = Number.isFinite(options.retryCount)
      ? Math.max(0, Math.floor(options.retryCount))
      : DEFAULT_RETRY_COUNT;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(0, Math.floor(options.retryDelayMs))
      : DEFAULT_RETRY_DELAY_MS;
    this.retryJitterMs = Number.isFinite(options.retryJitterMs)
      ? Math.max(0, Math.floor(options.retryJitterMs))
      : DEFAULT_RETRY_JITTER_MS;
    this.clockDriftFactor = Number.isFinite(options.clockDriftFactor)
      ? Math.max(0, options.clockDriftFactor)
      : DEFAULT_CLOCK_DRIFT_FACTOR;
    this.now = options.now || (() => Date.now());
    this._tokenFactory = options.tokenFactory || randomToken;
  }

  _key(resource) {
    return `${this.prefix}${resource}`;
  }

  /**
   * tryAcquire — single attempt, no retries. Returns a LockHandle on
   * success or null on contention/error. Use this when the caller
   * wants explicit control over backoff (e.g. the idempotency
   * middleware, which has its own polling loop).
   */
  async tryAcquire(resource, ttlMs = DEFAULT_TTL_MS) {
    const ttl = clampTtl(ttlMs);
    const key = this._key(resource);
    const token = this._tokenFactory();
    const start = this.now();
    let setRes;
    try {
      setRes = await this.client.set(key, token, 'PX', ttl, 'NX');
    } catch (_err) {
      // Backend failure is treated as "did not acquire". The caller
      // chooses fail-open vs fail-closed — this primitive does not
      // pretend to own the lock when it cannot prove ownership.
      return null;
    }
    if (setRes !== 'OK' && setRes !== true && setRes !== 1) {
      return null;
    }
    const drift = Math.max(2, Math.floor(ttl * this.clockDriftFactor) + 2);
    // If acquiring the lock itself ate most of the TTL (slow Redis,
    // GC pause), the lock is already practically expired. Release it
    // and report failure rather than hand the caller a useless handle.
    const elapsed = this.now() - start;
    const validityMs = ttl - elapsed - drift;
    if (validityMs <= 0) {
      try {
        await this.client.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (_err) {
        // best-effort
      }
      return null;
    }
    return new LockHandle({
      redlock: this,
      resource,
      key,
      token,
      ttlMs: ttl,
      expiresAt: this.now() + validityMs,
    });
  }

  /**
   * acquire — repeated tryAcquire with backoff and jitter. Returns a
   * handle or null. Throws only on caller-error (bad arguments).
   */
  async acquire(resource, ttlMs = DEFAULT_TTL_MS, options = {}) {
    if (!resource || typeof resource !== 'string') {
      throw new RedlockError('resource must be a non-empty string', 'REDLOCK_BAD_RESOURCE');
    }
    const retryCount = Number.isFinite(options.retryCount) ? options.retryCount : this.retryCount;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : this.retryDelayMs;
    const retryJitterMs = Number.isFinite(options.retryJitterMs) ? options.retryJitterMs : this.retryJitterMs;
    let attempts = 0;
    while (true) {
      const handle = await this.tryAcquire(resource, ttlMs);
      if (handle) return handle;
      attempts += 1;
      if (attempts > retryCount) return null;
      const jitter = retryJitterMs > 0 ? Math.floor(Math.random() * retryJitterMs) : 0;
      await delay(retryDelayMs + jitter);
    }
  }

  async _releaseHandle(handle) {
    try {
      const res = await this.client.eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
      return res === 1 || res === '1';
    } catch (_err) {
      return false;
    }
  }

  async _extendHandle(handle, newTtlMs) {
    const ttl = clampTtl(newTtlMs);
    try {
      const res = await this.client.eval(EXTEND_SCRIPT, 1, handle.key, handle.token, ttl);
      if (res === 1 || res === '1') {
        const drift = Math.max(2, Math.floor(ttl * this.clockDriftFactor) + 2);
        handle.ttlMs = ttl;
        handle.expiresAt = this.now() + ttl - drift;
        return true;
      }
      return false;
    } catch (_err) {
      return false;
    }
  }

  /**
   * using — acquire / run / release. The classic single-flight
   * helper. Releases on both happy path and exception. Returns the
   * value returned by `fn` on acquisition; throws RedlockError with
   * code REDLOCK_NOT_ACQUIRED if the lock could not be obtained.
   *
   * The caller's `fn` receives the handle so it can call extend()
   * for long critical sections. We do NOT auto-extend in the
   * background — silent extensions can mask a stuck handler.
   */
  async using(resource, ttlMs, fn, options = {}) {
    if (typeof fn !== 'function') {
      throw new RedlockError('using() requires a function', 'REDLOCK_BAD_FN');
    }
    const handle = await this.acquire(resource, ttlMs, options);
    if (!handle) {
      throw new RedlockError(`could not acquire lock for ${resource}`, 'REDLOCK_NOT_ACQUIRED');
    }
    try {
      return await fn(handle);
    } finally {
      await handle.release();
    }
  }
}

/**
 * createRedlock — convenience factory matching the rest of the
 * concurrency module style. Pass `{ client }` for tests, otherwise
 * pass an `ioredis` client.
 */
function createRedlock(options = {}) {
  return new Redlock(options);
}

module.exports = {
  Redlock,
  LockHandle,
  RedlockError,
  createRedlock,
  createMemoryLockBackend,
  RELEASE_SCRIPT,
  EXTEND_SCRIPT,
  DEFAULT_TTL_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_PREFIX,
};
