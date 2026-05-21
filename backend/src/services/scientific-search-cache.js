'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = Number.parseInt(process.env.SCIENTIFIC_SEARCH_CACHE_TTL_MS || '900000', 10);
const MAX_ENTRIES = Number.parseInt(process.env.SCIENTIFIC_SEARCH_CACHE_MAX || '200', 10);

const cache = new Map();

function cacheKey(query, opts = {}) {
  const providers = Array.isArray(opts.providers) ? opts.providers.slice().sort().join(',') : 'all';
  const limit = Number(opts.limit) || 10;
  const raw = `${String(query || '').trim().toLowerCase()}|${providers}|${limit}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function get(query, opts) {
  const key = cacheKey(query, opts);
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { ...row.value, _cache: { hit: true, ageMs: Date.now() - row.storedAt } };
}

function set(query, opts, value, ttlMs = DEFAULT_TTL_MS) {
  const key = cacheKey(query, opts);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    value,
    storedAt: Date.now(),
    expiresAt: Date.now() + Math.max(60_000, ttlMs),
  });
}

function clear() {
  cache.clear();
}

function stats() {
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
