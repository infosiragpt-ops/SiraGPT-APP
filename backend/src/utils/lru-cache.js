'use strict';

/**
 * lru-cache — LRU cache with optional per-entry TTL. Uses the Map
 * iteration-order trick (delete-then-set on hit promotes to MRU
 * position, oldest by iteration order is the LRU victim). Pure JS,
 * zero deps. Sits at utils/ as a reusable primitive — distinct from
 * services/cache/* which are application-flavored.
 *
 * Public API:
 *   const c = createLruCache({ max = 1024, ttlMs = 0, now })
 *     ttlMs = 0 disables TTL (LRU-only).
 *   c.get(key)             — undefined if missing or expired
 *   c.peek(key)            — like get but does not refresh LRU order
 *   c.has(key)             — boolean
 *   c.set(key, value, perEntryTtlMs?)  → value (overrides default ttlMs)
 *   c.del(key)             — boolean
 *   c.clear()
 *   c.size()
 *   c.snapshot()           — { size, max, ttlMs, hits, misses, evictions }
 *   c.entries()            — generator [k, v] in MRU→LRU order
 */

const DEFAULT_MAX = 1024;

function createLruCache(opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : DEFAULT_MAX;
  const defaultTtlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : 0;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** Map<key, { value, expiresAt }> */
  const store = new Map();
  let hits = 0, misses = 0, evictions = 0;

  function isExpired(entry, t) {
    return entry.expiresAt > 0 && entry.expiresAt <= t;
  }

  function touch(key, entry) {
    // Re-insert moves to end of iteration order (MRU position).
    store.delete(key);
    store.set(key, entry);
  }

  function get(key) {
    const e = store.get(key);
    if (e === undefined) { misses += 1; return undefined; }
    const t = now();
    if (isExpired(e, t)) {
      store.delete(key);
      misses += 1;
      return undefined;
    }
    touch(key, e);
    hits += 1;
    return e.value;
  }

  function peek(key) {
    const e = store.get(key);
    if (e === undefined) return undefined;
    if (isExpired(e, now())) {
      store.delete(key);
      return undefined;
    }
    return e.value;
  }

  function has(key) {
    return peek(key) !== undefined;
  }

  function set(key, value, perEntryTtlMs) {
    const ttl = Number.isFinite(perEntryTtlMs) && perEntryTtlMs > 0
      ? Math.floor(perEntryTtlMs)
      : defaultTtlMs;
    const expiresAt = ttl > 0 ? now() + ttl : 0;
    if (store.has(key)) store.delete(key);
    store.set(key, { value, expiresAt });
    while (store.size > max) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
      evictions += 1;
    }
    return value;
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
  }

  function size() { return store.size; }

  function snapshot() {
    return { size: store.size, max, ttlMs: defaultTtlMs, hits, misses, evictions };
  }

  function* entries() {
    // Map iteration order is insertion order; we want MRU-first → reverse.
    const arr = [...store];
    for (let i = arr.length - 1; i >= 0; i--) {
      const [k, e] = arr[i];
      if (!isExpired(e, now())) yield [k, e.value];
    }
  }

  return { get, peek, has, set, del, clear, size, snapshot, entries };
}

module.exports = {
  createLruCache,
  DEFAULT_MAX,
};
