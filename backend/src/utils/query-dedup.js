'use strict';

/**
 * query-dedup — coalesce concurrent identical reads inside a small TTL
 * window (default 50ms). Two callers asking for `findUnique({where:{id}})`
 * within the same window get the same Promise; only one DB roundtrip
 * happens. The TTL is intentionally short — we're collapsing the
 * "thundering herd of inflight requests for the same hot row", not
 * caching results.
 *
 * Key derivation:
 *   key = sha1(model + '|' + stableJSON({where, select, include}))
 *   Stable JSON so {id:'a',name:'b'} and {name:'b',id:'a'} share a key.
 *
 * API:
 *   const dedup = createQueryDedup({ ttlMs?, now?, maxEntries? })
 *   dedup.run(key, fn) → fn() result, shared across overlapping callers
 *   dedup.wrap(model, args, fn) → shorthand that hashes the key
 *   dedup.size() / dedup.clear()
 *
 * Failure semantics:
 *   If the wrapped fn rejects, all waiters reject too (this is the
 *   correct behavior — they'd have failed identically on their own DB
 *   call). The entry is evicted immediately on rejection so the next
 *   caller retries instead of receiving a stuck error.
 */

const { createHash } = require('node:crypto');

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function buildKey(model, args) {
  const argsKey = stableStringify({
    where: args && args.where,
    select: args && args.select,
    include: args && args.include,
  });
  return createHash('sha1').update(`${model}|${argsKey}`).digest('hex');
}

function createQueryDedup(opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? Math.floor(opts.ttlMs) : 50;
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
    ? Math.floor(opts.maxEntries)
    : 2000;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<string, {promise: Promise<any>, expiresAt: number}>} */
  const inflight = new Map();
  let hits = 0;
  let misses = 0;

  function gc() {
    if (inflight.size === 0) return;
    const cutoff = now();
    for (const [k, entry] of inflight) {
      if (entry.expiresAt <= cutoff) inflight.delete(k);
    }
  }

  function evict(key) {
    inflight.delete(key);
  }

  function run(key, fn) {
    gc();
    const existing = inflight.get(key);
    if (existing && existing.expiresAt > now()) {
      hits += 1;
      return existing.promise;
    }
    misses += 1;
    if (inflight.size >= maxEntries) {
      const firstKey = inflight.keys().next().value;
      if (firstKey !== undefined) inflight.delete(firstKey);
    }
    const promise = Promise.resolve()
      .then(() => fn())
      .then(
        (value) => {
          // Schedule eviction so the same key after TTL goes to DB again.
          // We don't clear immediately because additional waiters that
          // attach within the same window must hit this cached promise.
          setTimeout(() => evict(key), ttlMs).unref?.();
          return value;
        },
        (err) => {
          // Failure: evict immediately so retries don't see the rejection.
          evict(key);
          throw err;
        }
      );
    inflight.set(key, { promise, expiresAt: now() + ttlMs });
    return promise;
  }

  function wrap(model, args, fn) {
    if (ttlMs === 0) return Promise.resolve().then(() => fn());
    const key = buildKey(model, args || {});
    return run(key, fn);
  }

  function clear() { inflight.clear(); }
  function size() { return inflight.size; }
  function stats() { return { hits, misses, pending: inflight.size, ttlMs }; }

  return { run, wrap, clear, size, stats, buildKey };
}

module.exports = {
  createQueryDedup,
  buildKey,
  stableStringify,
};
