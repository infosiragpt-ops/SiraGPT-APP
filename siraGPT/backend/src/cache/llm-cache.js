'use strict';

/**
 * llm-cache — caching wrapper for chat-completions and embeddings.
 *
 * Builds a deterministic cache key from (model, messages, temperature, tools,
 * system) for chat, and (model, input) for embeddings. Bypasses the cache
 * when the request is non-deterministic (temperature > 0, top_p < 1, n > 1,
 * stream:true) or when tools are flagged as non-idempotent.
 *
 * Public API:
 *   - SIRA_CACHE_ENABLED (env): master feature flag (default off).
 *   - getOrCompute({ kind, request, compute }) — pulls from TwoTier or runs compute().
 *   - buildChatKey(req) / buildEmbeddingKey(req) — exposed for testing.
 *   - shouldBypassChat(req) / shouldBypassEmbedding(req) — predicates.
 *   - getCache(opts?) — singleton TwoTier (lazy, env-driven).
 *
 * The wrapper is provider-agnostic. Callers normalize their OpenAI/Anthropic
 * request shape into the canonical keying inputs (see normalizeMessages).
 */

const { createHash } = require('node:crypto');
const { TwoTier } = require('./TwoTier');
const { createRedisStore } = require('./RedisStore');
const {
  isSemanticCacheEnabled,
  getSemanticCache,
  buildScopeKey,
  extractSemanticQuery,
} = require('./semantic');

const KEY_VERSION = 'v1';
const DEFAULT_CHAT_TTL_MS = 10 * 60 * 1000;     // 10 min
const DEFAULT_EMBEDDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h — embeddings are stable
const MIN_BYPASS_TEMPERATURE = 0.0001;

/**
 * Tools that mutate state, hit the network, or otherwise return non-idempotent
 * results — calls invoking these MUST bypass the cache. Conservative by
 * default: anything not on this list of read-only tools forces a bypass when
 * tools are present.
 */
const IDEMPOTENT_TOOL_NAMES = new Set([
  'get_time',
  'get_date',
  'lookup_static',
]);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isCacheEnabled(env = process.env) {
  return parseBoolean(env.SIRA_CACHE_ENABLED, false);
}

function stableStringify(value) {
  // Deterministic JSON stringify with sorted keys so equivalent objects hash
  // identically regardless of property order.
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: String(m ?? '') };
    return {
      role: m.role || 'user',
      content: typeof m.content === 'string' ? m.content : stableStringify(m.content ?? ''),
      name: m.name || undefined,
      tool_call_id: m.tool_call_id || undefined,
    };
  });
}

function hashKey(parts) {
  const payload = stableStringify(parts);
  return createHash('sha256').update(payload).digest('hex');
}

function buildChatKey(request = {}) {
  const messages = normalizeMessages(request.messages);
  const tools = Array.isArray(request.tools) ? request.tools.map((t) => ({
    name: t?.function?.name || t?.name || null,
    schema: t?.function?.parameters || t?.parameters || null,
  })) : [];
  const parts = {
    v: KEY_VERSION,
    kind: 'chat',
    provider: request.provider || null,
    model: request.model || null,
    messages,
    tools,
    system: request.system || null,
    response_format: request.response_format || null,
    // temperature/top_p excluded from key when present and within bypass-trigger
    // bounds; only deterministic-equivalent temps make it here (temperature=0).
    temperature: 0,
  };
  return `chat:${KEY_VERSION}:${hashKey(parts)}`;
}

function buildEmbeddingKey(request = {}) {
  const input = Array.isArray(request.input) ? request.input.slice() : [request.input];
  const parts = {
    v: KEY_VERSION,
    kind: 'embed',
    provider: request.provider || null,
    model: request.model || null,
    input,
    dimensions: request.dimensions || null,
    encoding_format: request.encoding_format || null,
  };
  return `embed:${KEY_VERSION}:${hashKey(parts)}`;
}

function toolsAreIdempotent(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return true;
  for (const t of tools) {
    const name = t?.function?.name || t?.name;
    if (!name || !IDEMPOTENT_TOOL_NAMES.has(name)) return false;
  }
  return true;
}

function shouldBypassChat(request = {}) {
  if (!request) return true;
  if (request.stream === true) return true;
  if (request.n != null && Number(request.n) > 1) return true;
  const t = Number(request.temperature);
  if (Number.isFinite(t) && t > MIN_BYPASS_TEMPERATURE) return true;
  const topP = Number(request.top_p);
  if (Number.isFinite(topP) && topP > 0 && topP < 1) return true;
  if (!toolsAreIdempotent(request.tools)) return true;
  if (request.cache === false) return true;
  return false;
}

function shouldBypassEmbedding(request = {}) {
  if (!request) return true;
  if (request.cache === false) return true;
  if (request.input == null) return true;
  return false;
}

let _singleton = null;
function getCache(options = {}) {
  if (options.fresh) {
    _singleton = null;
  }
  if (_singleton) return _singleton;
  const env = options.env || process.env;
  const l2 = options.l2 !== undefined
    ? options.l2
    : createRedisStore(env, { prefix: env.SIRA_CACHE_REDIS_PREFIX || 'sira:cache:' });
  _singleton = new TwoTier({
    l2,
    l1MaxEntries: Number(env.SIRA_CACHE_L1_MAX) || 1000,
    l1TtlMs: Number(env.SIRA_CACHE_L1_TTL_MS) || DEFAULT_CHAT_TTL_MS,
    defaultTtlMs: Number(env.SIRA_CACHE_TTL_MS) || DEFAULT_CHAT_TTL_MS,
  });
  // Optional wiring: under SIRA_RELIABILITY_WIRINGS=1, subscribe the L1
  // tier to the central context-invalidator. We deliberately do NOT clear
  // L2 (Redis) on local invalidation events because that would produce a
  // fan-out blast across replicas; cluster-wide L2 clears are an
  // ops-level concern. Default OFF — degrades silently on errors.
  try {
    const { wireSubscribeIfEnabled } = require('./wireup');
    const cache = _singleton;
    wireSubscribeIfEnabled({
      name: 'llm-cache-l1',
      patterns: ['context.*', 'user.*'],
      handler: () => {
        if (cache && cache.l1 && typeof cache.l1.clear === 'function') cache.l1.clear();
      },
      holder: cache,
      env,
    });
  } catch { /* defensive */ }
  return _singleton;
}

function _resetSingletonForTests() { _singleton = null; }

/**
 * High-level cache-aside. Caller passes a `compute` thunk that runs the real
 * provider call when the cache misses or is bypassed. `kind` is 'chat' or
 * 'embedding'; the wrapper picks the right key + bypass predicate.
 */
async function getOrCompute({ kind, request, compute, cache, env, ttlMs, semantic } = {}) {
  if (typeof compute !== 'function') {
    throw new TypeError('getOrCompute: compute() is required');
  }
  const eff = env || process.env;
  if (!isCacheEnabled(eff)) return compute();

  const c = cache || getCache({ env: eff });
  let key;
  let bypass;
  let defaultTtl;
  if (kind === 'chat') {
    bypass = shouldBypassChat(request);
    key = bypass ? null : buildChatKey(request);
    defaultTtl = DEFAULT_CHAT_TTL_MS;
  } else if (kind === 'embedding') {
    bypass = shouldBypassEmbedding(request);
    key = bypass ? null : buildEmbeddingKey(request);
    defaultTtl = DEFAULT_EMBEDDING_TTL_MS;
  } else {
    throw new TypeError(`getOrCompute: unknown kind "${kind}"`);
  }

  if (bypass || !key) {
    c.recordBypass();
    return compute();
  }

  const hit = await c.get(key);
  if (hit !== undefined) return hit;

  // Semantic layer (chat-only): only consulted on exact-cache miss. Falls
  // back silently if the embed function is missing or throws — a semantic
  // miss must never break the request path.
  const semCtx = kind === 'chat'
    ? await _trySemanticLookup({ request, env: eff, semantic, twoTier: c })
    : null;
  if (semCtx && 'value' in semCtx) {
    return semCtx.value;
  }

  const result = await compute();
  // Don't cache nullish — protects against transient empty responses.
  if (result !== undefined && result !== null) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtl;
    c.set(key, result, ttl);
    if (semCtx && semCtx.queryVec) {
      try {
        semCtx.store.set(semCtx.scope, semCtx.queryVec, result, { ttlMs: ttl });
      } catch (_err) { /* swallow — cache should not break compute */ }
    }
  }
  return result;
}

/**
 * Attempt a semantic-cache lookup. Returns one of:
 *   - { value }                                 — semantic hit, caller returns it
 *   - { store, scope, queryVec }                — miss but write-through context
 *   - null                                      — semantic disabled / unavailable
 *
 * Errors (missing key, embed throw, dimension mismatch) are swallowed and
 * surface as null so the request path is never gated on this layer.
 */
async function _trySemanticLookup({ request, env, semantic, twoTier }) {
  if (!isSemanticCacheEnabled(env)) return null;
  const queryText = extractSemanticQuery(request);
  if (!queryText) return null;
  const sem = semantic || getSemanticCache({ env });
  let embedFn = sem.embed;
  if (!embedFn) {
    // Lazy: try to bind rag-service.embed on first use. Wrapped in try
    // because rag-service requires OPENAI_API_KEY at call time, not at
    // require time, but circular/missing-deps would still surface here.
    try {
      const rag = require('../services/rag-service');
      if (typeof rag.embed === 'function') {
        embedFn = rag.embed;
        sem.setEmbed(embedFn);
      }
    } catch (_err) { /* no embedder available */ }
  }
  if (typeof embedFn !== 'function') return null;
  let queryVec;
  try {
    const embeds = await embedFn([queryText]);
    queryVec = Array.isArray(embeds) ? embeds[0] : null;
  } catch (_err) {
    return null;
  }
  if (!queryVec || queryVec.length === 0) return null;
  const scope = buildScopeKey(request);
  const hit = sem.store.get(scope, queryVec);
  if (hit) {
    if (twoTier && typeof twoTier.metrics?.recordSemanticHit === 'function') {
      twoTier.metrics.recordSemanticHit();
    }
    return { value: hit.value };
  }
  return { store: sem.store, scope, queryVec };
}

module.exports = {
  KEY_VERSION,
  DEFAULT_CHAT_TTL_MS,
  DEFAULT_EMBEDDING_TTL_MS,
  IDEMPOTENT_TOOL_NAMES,
  isCacheEnabled,
  stableStringify,
  normalizeMessages,
  buildChatKey,
  buildEmbeddingKey,
  shouldBypassChat,
  shouldBypassEmbedding,
  toolsAreIdempotent,
  getCache,
  getOrCompute,
  _resetSingletonForTests,
};
