'use strict';

/**
 * llm-response-cache — exact-match prompt cache for LLM responses.
 *
 * Why this exists:
 *   Production chat traffic has a non-trivial fraction of identical
 *   prompts ("Hello", "What can you do?", boilerplate questions
 *   from Custom GPTs, retried-after-network-blip turns where the
 *   client lost the SSE response). Each hits the provider API
 *   fresh — burning tokens, latency, and cost. A cache keyed on
 *   normalized prompt + model + temperature + system-prompt-hash
 *   short-circuits these.
 *
 * "Semantic" in the file name is aspirational:
 *   v1 (this commit) is EXACT-MATCH only. Two prompts that differ
 *   by whitespace or trailing punctuation collide; two prompts
 *   that are paraphrases do NOT. A future v2 will key on the
 *   embedding vector (cosine-similar > 0.97) using either
 *   pgvector (already wired for RAG) or @upstash/vector.
 *
 *   v1 is still useful: typed-twice prompts, copy-paste retries,
 *   and Custom GPT canned responses are the bulk of the win.
 *
 * Design choices:
 *
 *   - Disabled by default. Activates when SEMANTIC_CACHE_ENABLED=
 *     true. Matches the precedent set by other observability /
 *     resilience scaffolds in this codebase (langfuse, posthog,
 *     idempotency).
 *
 *   - Tenant-isolated. The cache key includes the user-id so
 *     User A's "What's my plan?" never replays a response that
 *     mentions User B's plan. Anonymous traffic (no user-id)
 *     bypasses the cache entirely — anon prompts are too cheap
 *     to be worth caching and too privacy-loaded to share.
 *
 *   - Bounded TTL. 1 hour default — short enough that "What's
 *     today's date?" doesn't go stale, long enough that
 *     duplicate retries within a session hit the cache.
 *
 *   - Provider/model in key. A "Hello" answered by gpt-4 must NOT
 *     replay for gpt-3.5; the answer would be misleading.
 *
 *   - Temperature in key (rounded to 1 dp). temperature=0 prompts
 *     are perfectly cacheable; temperature=0.7 prompts can be
 *     cached but ops have to accept that "creativity" gets
 *     snapshotted on the first hit.
 *
 *   - System-prompt hash in key. Custom GPTs change the system
 *     prompt; the cache key must reflect that or one Custom GPT
 *     would replay another's answer.
 *
 * Public API:
 *   - resolveCacheConfig(env): pure env→config helper
 *   - normalizePrompt(text): lowercases, collapses whitespace,
 *     strips trailing punctuation. Pure, testable.
 *   - buildCacheKey({ userId, model, provider, temperature,
 *     systemPrompt, prompt }): hashes the inputs, returns a
 *     stable string key.
 *   - createInMemoryCache() / createRedisCache(redis) / createCache(env)
 *     factories matching the rate-limit-store / webauthn-
 *     challenge-store pattern.
 *   - put(key, response, ttlSeconds?) / get(key) on every store.
 *
 * NOT in scope (deliberately):
 *   - Wiring into the chat handler. The handler shape touches a
 *     lot of state (streaming, tool calls, intermediate messages)
 *     and a careful integration is its own commit.
 *   - Embedding-based "semantic" matching. Scaffold first, then
 *     a follow-up that swaps the storage from key→value to
 *     vector→[(value, vector)].
 */

const { createHash } = require('node:crypto');

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_PROMPT_BYTES = 64 * 1024;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveCacheConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.SEMANTIC_CACHE_ENABLED, false),
    ttlSeconds: clampInt(env.SEMANTIC_CACHE_TTL_SECONDS, DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS),
    redisPrefix: String(env.SEMANTIC_CACHE_REDIS_PREFIX || 'lcache:'),
    maxPromptBytes: clampInt(env.SEMANTIC_CACHE_MAX_PROMPT_BYTES, DEFAULT_MAX_PROMPT_BYTES, 1024, 1024 * 1024),
  };
}

/**
 * normalizePrompt — produce a canonical string for hashing. The
 * goal is to coalesce trivial variants ("Hello", "Hello!", "hello")
 * onto the same key without going so far that semantically
 * different prompts collide. Concretely:
 *
 *   - Lowercase (Hello / hello / HELLO collide).
 *   - Collapse runs of whitespace to a single space.
 *   - Strip trailing punctuation (! ? . , ;).
 *   - Trim leading / trailing whitespace.
 *
 * What we DO NOT do:
 *   - Stemming / stopword removal — would collide truly different
 *     questions ("Is X good?" vs "Why is X good?").
 *   - Unicode NFKC normalization — that's locale-loaded; we'd
 *     rather miss a cache hit than collapse two locales.
 *   - Trailing emoji stripping — emoji can carry intent.
 */
function normalizePrompt(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;]+\s*$/, '')
    .trim();
}

function hashSystemPrompt(text) {
  if (typeof text !== 'string' || text.length === 0) return 'sys:none';
  // Take a short content hash so the key stays compact.
  return `sys:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function buildCacheKey({ userId, model, provider, temperature, systemPrompt, prompt } = {}) {
  if (!userId || !prompt) return null;
  const normalized = normalizePrompt(prompt);
  if (!normalized) return null;
  // Round temperature to 1 decimal so 0.700001 and 0.7 share a key.
  const t = Number.isFinite(Number(temperature))
    ? Math.round(Number(temperature) * 10) / 10
    : 'na';
  const sys = hashSystemPrompt(systemPrompt);
  // Hash the prompt itself so the key length is bounded regardless
  // of prompt size. The plain normalized text is NOT in the key
  // (it could leak into Redis-monitor logs); only its hash is.
  const promptHash = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return [
    `u:${userId}`,
    `p:${provider || 'na'}`,
    `m:${model || 'na'}`,
    `t:${t}`,
    sys,
    `h:${promptHash}`,
  ].join('|');
}

function createInMemoryCache({ ttlSeconds = DEFAULT_TTL_SECONDS, now = () => Date.now(), maxEntries = 5000 } = {}) {
  const map = new Map();
  function gc() {
    const cutoff = now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= cutoff) map.delete(key);
    }
  }
  return {
    mode: 'memory',
    async get(key) {
      gc();
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, customTtlSeconds) {
      gc();
      // Bound the in-memory map. When over capacity, evict the
      // oldest entry first (FIFO — close enough to LRU for a cache
      // whose purpose is short-lived dedup, not lookup speed).
      if (map.size >= maxEntries && !map.has(key)) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
      }
      const ttl = (typeof customTtlSeconds === 'number' && customTtlSeconds > 0)
        ? customTtlSeconds
        : ttlSeconds;
      map.set(key, { value, expiresAt: now() + ttl * 1000 });
    },
    _size() { return map.size; },
  };
}

function createRedisCache({ redis, prefix, ttlSeconds }) {
  return {
    mode: 'redis',
    async get(key) {
      try {
        const raw = await redis.get(`${prefix}${key}`);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (_err) {
        return null;
      }
    },
    async put(key, value, customTtlSeconds) {
      const ttl = (typeof customTtlSeconds === 'number' && customTtlSeconds > 0)
        ? customTtlSeconds
        : ttlSeconds;
      try {
        await redis.set(`${prefix}${key}`, JSON.stringify(value), 'EX', ttl);
      } catch (_err) {
        // Cache misses on the put path are non-fatal — the next
        // identical prompt just runs the model again.
      }
    },
  };
}

let cachedRedisClient = null;
function loadRedisClient(env) {
  if (cachedRedisClient) return cachedRedisClient;
  if (!env.REDIS_URL) return null;
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (_err) {
    return null;
  }
  cachedRedisClient = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    connectTimeout: 2000,
  });
  cachedRedisClient.on('error', () => {});
  return cachedRedisClient;
}

function createCache(env = process.env, options = {}) {
  const config = resolveCacheConfig(env);
  if (options.forceMemory) return createInMemoryCache({ ttlSeconds: config.ttlSeconds });
  const redis = options.redis || loadRedisClient(env);
  if (!redis) return createInMemoryCache({ ttlSeconds: config.ttlSeconds });
  return createRedisCache({ redis, prefix: config.redisPrefix, ttlSeconds: config.ttlSeconds });
}

module.exports = {
  resolveCacheConfig,
  normalizePrompt,
  buildCacheKey,
  hashSystemPrompt,
  createInMemoryCache,
  createRedisCache,
  createCache,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
};
