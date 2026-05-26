'use strict';

/**
 * document-analyzer-cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * In-process content-hash cache for deterministic document analyzers.
 *
 * The enrichment pipeline now runs 75+ analyzers per chat turn. Each
 * is deterministic: the same input text always produces the same
 * output. When the same file is referenced across multiple turns in
 * a conversation, the analyzers re-run from scratch. This module
 * provides a memoization layer keyed by a content-hash so callers
 * can short-circuit re-extraction.
 *
 * Design choices:
 *  - LRU eviction with a hard-coded ceiling (5000 entries) keeps
 *    memory predictable in long-running processes.
 *  - Cache is process-scoped (no cross-process shared store). For
 *    horizontal scaling, callers should layer a Redis adapter on
 *    top with the same { key, value } envelope.
 *  - Hash is content-only (no filename / id). Two files with
 *    identical body share the same cache key.
 *
 * Public API:
 *   computeHash(text)                  → string
 *   makeKey(analyzerName, contentHash) → string
 *   get(key)                           → any | undefined
 *   set(key, value)                    → void
 *   has(key)                           → boolean
 *   stats()                            → { size, hits, misses, ratio }
 *   reset()                            → void
 *   memoize(analyzerName, fn)          → wrappedFn(text, ...args)
 */

const crypto = require('crypto');

const MAX_ENTRIES = 5000;

const store = new Map();
let hits = 0;
let misses = 0;

function computeHash(text) {
  const s = typeof text === 'string' ? text : '';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
}

function makeKey(analyzerName, contentHash) {
  return `${analyzerName}|${contentHash}`;
}

function get(key) {
  if (!store.has(key)) {
    misses++;
    return undefined;
  }
  hits++;
  // Touch: move to most-recently-used position.
  const value = store.get(key);
  store.delete(key);
  store.set(key, value);
  return value;
}

function set(key, value) {
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  // Evict oldest until under the ceiling.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function has(key) {
  return store.has(key);
}

function stats() {
  const total = hits + misses;
  return {
    size: store.size,
    hits,
    misses,
    ratio: total === 0 ? 0 : Number((hits / total).toFixed(3)),
  };
}

function reset() {
  store.clear();
  hits = 0;
  misses = 0;
}

/**
 * Wrap a deterministic analyzer function so subsequent calls with
 * the same first-argument text hit the cache.
 *
 * Example:
 *   const cached = memoize('kpi', extractKpis);
 *   const r1 = cached(text);      // miss → extracts
 *   const r2 = cached(text);      // hit  → cached
 *
 * Subsequent args are passed through but NOT included in the cache
 * key. Wrap only analyzers whose output depends solely on `text`.
 */
function memoize(analyzerName, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('memoize expects a function');
  }
  return function memoized(text, ...rest) {
    const key = makeKey(analyzerName, computeHash(text));
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = fn(text, ...rest);
    set(key, value);
    return value;
  };
}

module.exports = {
  computeHash,
  makeKey,
  get,
  set,
  has,
  stats,
  reset,
  memoize,
  _internal: {
    MAX_ENTRIES,
  },
};
