'use strict';

/**
 * key-mutex — async mutex per key, lighter than the lease-mutex (#26)
 * which is task-scoped with leases + heartbeat. This one is request-
 * scoped: serializes async runs over the same key in-process. Two
 * common shapes:
 *
 *   1. acquire/release pattern  — when you own the lifecycle.
 *   2. withLock(key, fn) helper — when you can wrap a single block.
 *
 * Used for refresh-once caches, race-prone counters, and any spot
 * where two concurrent callers should "do this exactly once even
 * though they raced through the door". Pairs with idempotency LRU
 * (#13) which dedupes by argument hash; this dedupes by key.
 *
 * Public API:
 *   const mu = createKeyMutex({ maxKeys = 10_000 })
 *   const release = await mu.acquire(key)
 *   try { ... } finally { release() }
 *
 *   const value = await mu.withLock(key, async () => fetchAndStore())
 *
 *   mu.isLocked(key) / mu.size() / mu.snapshot()
 */

const DEFAULT_MAX_KEYS = 10_000;

function createKeyMutex(opts = {}) {
  const maxKeys = Number.isInteger(opts.maxKeys) && opts.maxKeys > 0 ? opts.maxKeys : DEFAULT_MAX_KEYS;
  /** Map<key, { tail: Promise }> — tail resolves when current holder releases. */
  const locks = new Map();
  let totalAcquires = 0;
  let totalQueued = 0;

  function acquire(key) {
    if (typeof key !== 'string' || !key) {
      return Promise.reject(new TypeError('key-mutex: key required'));
    }
    totalAcquires += 1;
    const prevTail = locks.get(key);
    let releaseFn;
    const newTail = new Promise((resolve) => { releaseFn = resolve; });
    locks.set(key, { tail: newTail });
    if (locks.size > maxKeys) {
      // Evict least-recently-touched non-pending key (rare; the LRU
      // here just bounds memory if a buggy caller leaks keys).
      const oldest = locks.keys().next().value;
      if (oldest !== key) locks.delete(oldest);
    }

    const queueWait = prevTail
      ? (totalQueued += 1, prevTail.tail.then(() => undefined))
      : Promise.resolve();

    return queueWait.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseFn();
        // GC the slot only if no one queued behind us in the meantime.
        if (locks.get(key) && locks.get(key).tail === newTail) {
          locks.delete(key);
        }
      };
    });
  }

  async function withLock(key, fn) {
    if (typeof fn !== 'function') throw new TypeError('key-mutex.withLock: fn required');
    const release = await acquire(key);
    try { return await fn(); }
    finally { release(); }
  }

  function isLocked(key) {
    return locks.has(key);
  }

  function size() { return locks.size; }

  function snapshot() {
    return { activeKeys: locks.size, maxKeys, totalAcquires, totalQueued };
  }

  return { acquire, withLock, isLocked, size, snapshot };
}

module.exports = {
  createKeyMutex,
  DEFAULT_MAX_KEYS,
};
