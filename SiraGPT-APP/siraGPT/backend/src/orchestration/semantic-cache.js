'use strict';

const crypto = require('node:crypto');

const VOLATILE_QUERY_RE = /\b(now|today|ayer|hoy|mañana|current|actual|latest|últim[ao]s?|timestamp|fecha|hora|news|precio|weather)\b/i;

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
  const payload = stableStringify({ prompt: normalized, context, model, temperature });
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
