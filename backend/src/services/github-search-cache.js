'use strict';

/**
 * github-search-cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiny in-memory TTL+LRU cache for GitHub search results. Mirrors the design of
 * scientific-search-cache.js so the two search subsystems behave identically
 * (same eviction policy, same clone-on-read isolation, same env knobs).
 *
 * GitHub's search API is aggressively rate-limited (10 req/min unauthenticated,
 * 30 req/min authenticated), so caching repeated queries is the single biggest
 * lever for both latency and staying under the quota.
 *
 * Env:
 *   GITHUB_SEARCH_CACHE_TTL_MS  — entry lifetime (default 300000 = 5 min)
 *   GITHUB_SEARCH_CACHE_MAX     — max entries before LRU eviction (default 200)
 */

const crypto = require('crypto');

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// GitHub data is more volatile than scientific papers, so the default TTL is
// shorter (5 min vs 15 min) — fresh star counts / new repos matter here.
const DEFAULT_TTL_MS = positiveInt(process.env.GITHUB_SEARCH_CACHE_TTL_MS, 300000);
const MAX_ENTRIES = positiveInt(process.env.GITHUB_SEARCH_CACHE_MAX, 200);

const cache = new Map();

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function evictExpired(now = Date.now()) {
  for (const [key, row] of cache) {
    if (now > row.expiresAt) cache.delete(key);
  }
}

function cacheKey(query, opts = {}) {
  const type = String(opts.type || 'repositories');
  const sort = String(opts.sort || 'default');
  const order = String(opts.order || 'desc');
  const limit = Number(opts.limit) || 10;
  const lang = String(opts.language || '');
  const timeoutMs = Number(opts.timeoutMs) || 'default';
  // Scope filters that change the underlying result set MUST be part of the key.
  // The per-type searchers read these (searchIssues → repo/state/kind,
  // searchCode → repo/filename, searchRepositories → minStars/topic). Omitting
  // them let e.g. {state:'open'} and {state:'closed'} collide on the same key,
  // so the second call returned the first call's wrong-scope results for the TTL.
  const repo = String(opts.repo || '');
  const state = String(opts.state || '');
  const kind = String(opts.kind || '');
  const minStars = Number(opts.minStars) || 0;
  const topic = String(opts.topic || '');
  const filename = String(opts.filename || '');
  const raw = [
    String(query || '').trim().toLowerCase(),
    type, sort, order, limit, lang, timeoutMs,
    repo, state, kind, minStars, topic, filename,
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function get(query, opts) {
  const key = cacheKey(query, opts);
  const row = cache.get(key);
  if (!row) return null;
  const now = Date.now();
  if (now > row.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Re-insert to mark as most-recently-used (Map preserves insertion order).
  cache.delete(key);
  cache.set(key, row);
  return {
    ...cloneValue(row.value),
    _cache: { hit: true, ageMs: now - row.storedAt },
  };
}

function set(query, opts, value, ttlMs = DEFAULT_TTL_MS) {
  const key = cacheKey(query, opts);
  evictExpired();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  const now = Date.now();
  cache.set(key, {
    value: cloneValue(value),
    storedAt: now,
    expiresAt: now + Math.max(30_000, positiveInt(ttlMs, DEFAULT_TTL_MS)),
  });
}

function clear() {
  cache.clear();
}

function stats() {
  evictExpired();
  return { size: cache.size, maxEntries: MAX_ENTRIES, ttlMs: DEFAULT_TTL_MS };
}

module.exports = {
  cacheKey,
  get,
  set,
  clear,
  stats,
  DEFAULT_TTL_MS,
};
