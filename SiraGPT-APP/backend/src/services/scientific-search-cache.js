'use strict';

const crypto = require('crypto');

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_TTL_MS = positiveInt(process.env.SCIENTIFIC_SEARCH_CACHE_TTL_MS, 900000);
const MAX_ENTRIES = positiveInt(process.env.SCIENTIFIC_SEARCH_CACHE_MAX, 200);

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
  const providers = Array.isArray(opts.providers) ? opts.providers.slice().sort().join(',') : 'all';
  const limit = Number(opts.limit) || 10;
  const timeoutMs = Number(opts.timeoutMs) || 'default';
  // Result-shaping flags MUST be part of the key. Omitting them let a cached
  // non-enriched/diversified result be returned when a later call flips an
  // opt-in flag — so `unpaywall:true` silently skipped the OA-PDF backfill and
  // `diversify:false` could return a diversified list, with no way for the
  // caller to tell.
  const diversify = opts.diversify === false ? '0' : '1';
  const unpaywall = opts.unpaywall ? '1' : '0';
  const maxRun = Number(opts.maxRun) || 'd';
  const maxEnrich = Number(opts.maxEnrichUnpaywall) || 'd';
  const raw = `${String(query || '').trim().toLowerCase()}|${providers}|${limit}|${timeoutMs}|${diversify}|${unpaywall}|${maxRun}|${maxEnrich}`;
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
    expiresAt: now + Math.max(60_000, positiveInt(ttlMs, DEFAULT_TTL_MS)),
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
