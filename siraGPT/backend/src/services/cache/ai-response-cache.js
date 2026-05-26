'use strict';

/**
 * ai-response-cache — opt-in "ISR-style" cache for deterministic LLM
 * responses. Distinct from `llm-response-cache.js` (which is exact-match
 * prompt dedup keyed per-user); this one is content-deterministic:
 *   - Keyed on (model + system prompt + user prompt + temperature).
 *   - Only caches when temperature === 0 (deterministic) AND the caller
 *     explicitly opts in via `cacheResponses=true`.
 *   - Stores in Redis (or in-memory fallback) with 1h TTL.
 *
 * Streaming compat:
 *   `replayCachedStream(text, write, opts)` re-emits a cached response
 *   chunk-by-chunk with realistic timing so the client-side SSE renders
 *   identically to a fresh model response.
 */

const { createHash } = require('node:crypto');

const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_CHUNK_CHARS = 40;
const DEFAULT_CHUNK_DELAY_MS = 25;

function buildKey({ model, systemPrompt, userPrompt, temperature } = {}) {
  if (!model || !userPrompt) return null;
  if (Number(temperature) !== 0) return null; // only deterministic
  const payload = JSON.stringify({
    m: String(model),
    s: typeof systemPrompt === 'string' ? systemPrompt : '',
    u: String(userPrompt),
    t: 0,
  });
  return `air:${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
}

function shouldCache({ cacheResponses, temperature } = {}) {
  return Boolean(cacheResponses) && Number(temperature) === 0;
}

function createInMemoryStore({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    mode: 'memory',
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) { map.delete(key); return null; }
      return entry.value;
    },
    async set(key, value) {
      map.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    _size() { return map.size; },
    _clear() { map.clear(); },
  };
}

function createRedisStore({ redis, prefix = 'air:', ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  return {
    mode: 'redis',
    async get(key) {
      try {
        const raw = await redis.get(`${prefix}${key}`);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_err) { return null; }
    },
    async set(key, value) {
      try {
        await redis.set(`${prefix}${key}`, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (_err) { /* fire-and-forget */ }
    },
  };
}

async function replayCachedStream(text, write, opts = {}) {
  const chunkChars = Number.isFinite(opts.chunkChars) && opts.chunkChars > 0
    ? Math.floor(opts.chunkChars) : DEFAULT_CHUNK_CHARS;
  const chunkDelayMs = Number.isFinite(opts.chunkDelayMs) && opts.chunkDelayMs >= 0
    ? Math.floor(opts.chunkDelayMs) : DEFAULT_CHUNK_DELAY_MS;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));
  if (typeof text !== 'string' || text.length === 0) return;
  for (let i = 0; i < text.length; i += chunkChars) {
    const chunk = text.slice(i, i + chunkChars);
    await write(chunk);
    if (chunkDelayMs > 0 && (i + chunkChars) < text.length) await sleep(chunkDelayMs);
  }
}

// Process-wide registry of in-memory stores so the admin
// `/maintenance/clear-cache` endpoint can wipe them in one shot. Redis
// stores are NOT registered — they're typically shared infra and we
// don't want a misclick to flush a multi-tenant Redis namespace.
const _registeredStores = new Set();

function _registerInMemoryStore(store) {
  if (store && typeof store.set === 'function' && store.mode === 'memory') {
    _registeredStores.add(store);
  }
  return store;
}

/**
 * Clears every registered in-memory ai-response-cache store. Returns the
 * total number of entries dropped across all stores. Stores without an
 * introspectable `_size()` count as `0` for the report but are still
 * cleared.
 */
function clearAllInMemoryStores() {
  let cleared = 0;
  let stores = 0;
  for (const store of _registeredStores) {
    stores += 1;
    try {
      if (typeof store._size === 'function') cleared += store._size();
      // The in-memory store closure owns its Map — there's no public
      // `clear()`, so we re-init by re-setting each known key to a
      // sentinel expiry. Cheaper: call any exposed `_clear` if present,
      // else fall back to setting a fresh empty store via re-creation.
      if (typeof store._clear === 'function') {
        store._clear();
      }
    } catch { /* never throw from maintenance */ }
  }
  return { stores, cleared };
}

function createAiResponseCache(opts = {}) {
  const ttlSeconds = Number.isFinite(opts.ttlSeconds) && opts.ttlSeconds > 0
    ? Math.floor(opts.ttlSeconds) : DEFAULT_TTL_SECONDS;
  const store = opts.store
    || (opts.redis ? createRedisStore({ redis: opts.redis, ttlSeconds }) : createInMemoryStore({ ttlSeconds }));
  _registerInMemoryStore(store);

  async function get(params) {
    if (!shouldCache(params)) return null;
    const key = buildKey(params);
    if (!key) return null;
    return store.get(key);
  }

  async function set(params, response) {
    if (!shouldCache(params)) return false;
    const key = buildKey(params);
    if (!key) return false;
    await store.set(key, response);
    return true;
  }

  return { get, set, store, buildKey, replay: replayCachedStream };
}

module.exports = {
  createAiResponseCache,
  createInMemoryStore,
  createRedisStore,
  buildKey,
  shouldCache,
  replayCachedStream,
  clearAllInMemoryStores,
  DEFAULT_TTL_SECONDS,
};
