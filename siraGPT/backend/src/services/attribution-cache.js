'use strict';

/**
 * attribution-cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Content-addressable LRU cache for attribution-graph builds.
 *
 * The attribution-graph + intent-attribution pipelines are pure functions
 * of (prompt + context-bundle). When two consecutive turns share the same
 * inputs — e.g. the user hits regenerate, or two browser tabs send the
 * same question in parallel — we can avoid repeating ~30 ms of CPU work
 * by caching the previous bundle. Keys are SHA-256 of a canonicalized
 * input so two inputs that differ only in field order still hit.
 *
 * Intentionally tiny (default 256 entries, 10-minute TTL) so it never
 * accumulates large objects in long-lived processes.
 *
 * Public API:
 *   get(input)                                    → cached value | null
 *   set(input, value)                             → void
 *   getOrCompute(input, computeFn)                → value (sync or async)
 *   invalidate(input) / clear()                   → void
 *   memoize(fn, opts?)                            → memoized fn
 *   stats()                                       → { size, hits, misses, hitRate, ... }
 *
 * Tunables (env):
 *   SIRAGPT_ATTR_CACHE_MAX             (default 256)
 *   SIRAGPT_ATTR_CACHE_TTL_MS          (default 600000 = 10 min)
 *   SIRAGPT_ATTR_CACHE_DISABLED        ("1" disables entirely)
 */

const crypto = require('node:crypto');

const MAX_ENTRIES = Math.max(8, Number(process.env.SIRAGPT_ATTR_CACHE_MAX) || 256);
const TTL_MS = Math.max(10_000, Number(process.env.SIRAGPT_ATTR_CACHE_TTL_MS) || 600_000);
const DISABLED = String(process.env.SIRAGPT_ATTR_CACHE_DISABLED || '').toLowerCase() === '1';

const store = new Map();
const telemetry = { hits: 0, misses: 0, evictions: 0, expired: 0, sets: 0 };

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sortedKeys = Object.keys(value).sort();
  const out = {};
  for (const k of sortedKeys) out[k] = canonicalize(value[k]);
  return out;
}

function hashKey(input) {
  let json;
  try { json = JSON.stringify(canonicalize(input)); }
  catch (_err) { json = String(input); }
  return crypto.createHash('sha256').update(json).digest('hex');
}

const nowMs = () => Date.now();
const isExpired = (entry, now = nowMs()) => !entry || entry.expiresAt <= now;

function bumpLRU(key, entry) {
  store.delete(key);
  store.set(key, entry);
}

function evictIfNeeded() {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    telemetry.evictions += 1;
  }
}

function get(input) {
  if (DISABLED) return null;
  const key = hashKey(input);
  const entry = store.get(key);
  if (!entry) { telemetry.misses += 1; return null; }
  if (isExpired(entry)) {
    store.delete(key);
    telemetry.expired += 1;
    telemetry.misses += 1;
    return null;
  }
  bumpLRU(key, entry);
  telemetry.hits += 1;
  return entry.value;
}

function set(input, value) {
  if (DISABLED || value === undefined) return;
  const key = hashKey(input);
  const entry = { value, expiresAt: nowMs() + TTL_MS, computedAt: nowMs() };
  if (store.has(key)) store.delete(key);
  store.set(key, entry);
  telemetry.sets += 1;
  evictIfNeeded();
}

function invalidate(input) {
  store.delete(hashKey(input));
}

function clear() {
  store.clear();
  for (const k of Object.keys(telemetry)) telemetry[k] = 0;
}

/**
 * Memoized compute. Accepts sync or async `computeFn`. Returns the cached
 * value when present; otherwise runs the computeFn, stores, returns it.
 */
function getOrCompute(input, computeFn) {
  const cached = get(input);
  if (cached !== null) return cached;
  const result = computeFn();
  if (result && typeof result.then === 'function') {
    return result.then((value) => {
      if (value !== undefined) set(input, value);
      return value;
    });
  }
  if (result !== undefined) set(input, result);
  return result;
}

function memoize(fn, { keyExtractor = (...args) => args } = {}) {
  return function memoized(...args) {
    return getOrCompute(keyExtractor(...args), () => fn.apply(this, args));
  };
}

function stats() {
  const total = telemetry.hits + telemetry.misses;
  return {
    size: store.size,
    maxEntries: MAX_ENTRIES,
    ttlMs: TTL_MS,
    disabled: DISABLED,
    hits: telemetry.hits,
    misses: telemetry.misses,
    sets: telemetry.sets,
    evictions: telemetry.evictions,
    expired: telemetry.expired,
    hitRate: total === 0 ? 0 : Number((telemetry.hits / total).toFixed(4)),
  };
}

const __resetForTests = () => clear();

module.exports = {
  get, set, getOrCompute, invalidate, clear, memoize, stats,
  hashKey, canonicalize, __resetForTests,
  MAX_ENTRIES, TTL_MS, DISABLED,
};
