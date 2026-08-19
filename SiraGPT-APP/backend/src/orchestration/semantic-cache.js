'use strict';

const crypto = require('node:crypto');

// ── Volatile-query bypass ──────────────────────────────────────────────────
// Extended from Hermes Agent (MIT) semantic-cache patterns.
// Expanded to cover more time-sensitive Spanish/English phrases so cached
// responses are never served for queries about current state.
const VOLATILE_QUERY_RE = /\b(now|today|ayer|hoy|mañana|current|actual|latest|últim[ao]s?|timestamp|fecha|hora|news|precio|weather|ahora|reciente(?:mente)?|en\s+este\s+momento|actualmente|breaking|live|real.?time|tiempo\s+real)\b/i;

// ── Model cache-namespace versions ─────────────────────────────────────────
// Adapted from Hermes Agent (MIT):
//   fix(minimax): drop stale ≤204 800 cache entries for MiniMax-M3 (#36726)
//
// When a model's context window or output behaviour changes (e.g. MiniMax-M3
// context window expanded beyond 204 800 tokens), old cached responses
// produced under the smaller window are stale.  Bumping the version here
// invalidates every old key for that model — no Redis SCAN/DELETE needed.
//
// Convention: start at 1, bump by 1 for each breaking context/output change.
// Never decrement; never reuse a number.
const MODEL_CACHE_VERSIONS = Object.freeze({
  // MiniMax-M3 — context window expanded beyond 204 800 tokens (version 2)
  'minimax-m3':           2,
  'minimax/minimax-m3':   2,
  // Xiaomi MiMo — max_tokens hard-capped at 131 072 (version 2)
  'mimo-v2.5-pro':        2,
  // Add future model version bumps here; all others default to version 1.
});

function modelCacheVersion(model = '') {
  const normalised = String(model).toLowerCase();
  return MODEL_CACHE_VERSIONS[normalised] || 1;
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizePrompt(input = '') {
  return String(input)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldBypassSemanticCache({ prompt = '', ttlSeconds, volatile = false } = {}) {
  if (volatile) return true;
  if (ttlSeconds === 0) return true;
  return VOLATILE_QUERY_RE.test(String(prompt || ''));
}

function semanticCacheKey({ prompt = '', context = {}, model = '', temperature = 0 } = {}) {
  const normalized = normalizePrompt(prompt);
  // Include the model cache version so stale entries for models with
  // breaking context / output changes are automatically skipped.
  const version = modelCacheVersion(model);
  const payload = stableStringify({ prompt: normalized, context, model, temperature, _v: version });
  return `llm:semantic:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function resolveCacheTtlSeconds(taskType = 'default', env = process.env) {
  const specific = env[`SIRAGPT_CACHE_TTL_${String(taskType).toUpperCase()}`];
  const fallback = env.SIRAGPT_CACHE_TTL_DEFAULT_SECONDS || '3600';
  const ttl = Number.parseInt(specific || fallback, 10);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : 3600;
}

function createUpstashSemanticCache({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const enabled = Boolean(url && token && fetchImpl);

  async function command(args) {
    if (!enabled) return null;
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/${args.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.result ?? null;
  }

  return {
    enabled,
    async get(key) {
      const raw = await command(['get', key]);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_) { return raw; }
    },
    async set(key, value, ttlSeconds) {
      if (!enabled || ttlSeconds === 0) return false;
      const args = ['set', key, JSON.stringify(value)];
      if (ttlSeconds > 0) args.push('EX', String(ttlSeconds));
      const result = await command(args);
      return result === 'OK';
    },
  };
}

module.exports = {
  createUpstashSemanticCache,
  normalizePrompt,
  resolveCacheTtlSeconds,
  semanticCacheKey,
  shouldBypassSemanticCache,
  stableStringify,
};
