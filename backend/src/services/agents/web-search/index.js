/**
 * web-search adapter — single entrypoint that hides which free provider
 * served the query. Used by the `web_search` tool registered in
 * services/agents/agent-tools.js.
 *
 * Design goals (from task #34):
 *   - Zero paid keys in v1. Tier of free, key-less providers, tried in
 *     priority order; first non-empty wins.
 *   - Hard per-provider timeout so a hung public instance can't stall
 *     the whole turn.
 *   - Tiny in-memory LRU+TTL cache keyed on `(query, locale)` so we
 *     don't hammer the free providers when the LLM re-queries (which
 *     it does — multi-step plans repeat the same lookup).
 *   - Audit which provider answered so ops can spot "DDG is rate-
 *     limiting us again" without enabling debug logging.
 *   - Adding a paid provider tomorrow is a one-line registry insert.
 *
 * Shape returned to the caller:
 *   {
 *     results: [{ title, url, snippet, source }, …],
 *     provider: 'duckduckgo' | 'wikipedia' | 'searxng' | null,
 *     cached: boolean,
 *     attempts: [{ id, ok, ms, count, error? }],
 *   }
 */

const auditLog = require('../audit-log');

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 200;

const builtinProviders = [
  // Scientific tier (priority 3-7) — try the most authoritative sources
  // first. Each returns [] when the query has no scientific match, so
  // the adapter falls through cleanly to the general-web tier.
  require('./providers/crossref'),
  require('./providers/pubmed'),
  require('./providers/scielo'),
  require('./providers/openalex'),
  require('./providers/arxiv'),
  // General-web tier (priority 10-30).
  require('./providers/duckduckgo'),
  require('./providers/wikipedia'),
  require('./providers/searxng'),
];

// Mutable so tests can swap providers via setProviders().
let providers = sortProviders(builtinProviders);

function sortProviders(list) {
  return [...list]
    .filter((p) => p && typeof p.search === 'function' && p.enabled !== false)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

// ── error classifier ─────────────────────────────────────────────────
// Upstream errors (node-fetch, AbortError, JSON.parse) often embed the
// raw request URL — which includes ?q=<user query>. Bucket everything
// into a small, query-free enum before it touches the audit log.
function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (/timeout/.test(msg)) return 'timeout';
  if (/abort/.test(msg)) return 'aborted';
  const httpMatch = msg.match(/http\s*(\d{3})/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code >= 500) return 'http_5xx';
    if (code >= 400) return 'http_4xx';
    return 'http_other';
  }
  if (/invalid json|json/.test(msg)) return 'invalid_json';
  if (/network|enotfound|econnrefused|econnreset|fetch failed|getaddrinfo/.test(msg)) return 'network_error';
  return 'unknown_error';
}

// ── tiny LRU+TTL cache ───────────────────────────────────────────────
// A Map preserves insertion order in JS, so an LRU is just "delete +
// re-insert on hit, evict oldest when over capacity". TTL is enforced
// lazily on read so we never need a background timer.
class LruTtlCache {
  constructor({ max = DEFAULT_CACHE_MAX, ttlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  _key(query, locale) {
    return `${(locale || '').toLowerCase()}::${String(query || '').toLowerCase().trim()}`;
  }
  get(query, locale) {
    const key = this._key(query, locale);
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(query, locale, value) {
    const key = this._key(query, locale);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

const cache = new LruTtlCache();

// ── timeout wrapper ──────────────────────────────────────────────────
function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  let timer = null;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject the race FIRST, then signal-abort the provider so the
      // race winner is deterministically our timeout error (not the
      // provider's own "aborted" rejection that fires synchronously
      // from the abort listener).
      reject(new Error(`timeout after ${ms}ms`));
      try { ctrl.abort(); } catch (_) { /* best-effort */ }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  const run = Promise.resolve().then(() => promiseFactory(ctrl.signal));
  return Promise.race([run, timed]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ── adapter entry point ──────────────────────────────────────────────
async function search(query, opts = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) {
    return { results: [], provider: null, cached: false, attempts: [] };
  }
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 5, 15));
  const locale = typeof opts.locale === 'string' ? opts.locale : null;
  const timeoutMs = Math.max(500, Math.min(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 10000));

  const cached = cache.get(q, locale);
  if (cached) {
    return {
      results: cached.results.slice(0, maxResults),
      provider: cached.provider,
      cached: true,
      attempts: [],
    };
  }

  const attempts = [];
  for (const p of providers) {
    const start = Date.now();
    try {
      const results = await withTimeout(
        (signal) => p.search(q, { maxResults, locale, signal }),
        timeoutMs,
      );
      const list = Array.isArray(results) ? results : [];
      const normalised = list
        .filter((r) => r && typeof r.url === 'string' && typeof r.title === 'string')
        .map((r) => ({
          title: String(r.title).slice(0, 240),
          url: String(r.url),
          snippet: String(r.snippet || '').slice(0, 600),
          source: r.source || p.id,
        }));
      attempts.push({ id: p.id, ok: true, ms: Date.now() - start, count: normalised.length });
      if (normalised.length === 0) continue; // try next provider
      const value = { results: normalised, provider: p.id };
      cache.set(q, locale, value);
      // Audit WITHOUT the raw query — only its length — so secrets the
      // user might paste don't leak into the log feed.
      auditLog.audit({
        event: 'web_search',
        provider: p.id,
        hits: normalised.length,
        durationMs: Date.now() - start,
        queryLen: q.length,
        locale: locale || null,
        attempts: attempts.map(({ id, ok, ms, count }) => ({ id, ok, ms, count })),
        cached: false,
      });
      return { results: normalised.slice(0, maxResults), provider: p.id, cached: false, attempts };
    } catch (err) {
      // Never log the raw error message — node-fetch errors embed the
      // full request URL (which contains the user's query string),
      // which would leak the query into audit logs and violate the
      // "queryLen only" rule. Bucket into a small enum instead.
      attempts.push({
        id: p.id,
        ok: false,
        ms: Date.now() - start,
        error: classifyError(err),
      });
      // fall through to next provider
    }
  }

  // Every provider failed or returned empty. Per the spec, return []
  // and let the LLM handle the "no results" path rather than 500.
  auditLog.audit({
    event: 'web_search',
    provider: null,
    hits: 0,
    queryLen: q.length,
    locale: locale || null,
    attempts: attempts.map(({ id, ok, ms, count, error }) => ({ id, ok, ms, count, error })),
    cached: false,
  });
  return { results: [], provider: null, cached: false, attempts };
}

// ── test / extension hooks ───────────────────────────────────────────
function setProviders(list) {
  providers = sortProviders(list);
}

function getProviders() {
  return providers.map((p) => ({ id: p.id, name: p.name, priority: p.priority, enabled: p.enabled !== false }));
}

function resetProviders() {
  providers = sortProviders(builtinProviders);
}

function clearCache() { cache.clear(); }

module.exports = {
  search,
  setProviders,
  getProviders,
  resetProviders,
  clearCache,
  // exported for tests
  _cache: cache,
  _LruTtlCache: LruTtlCache,
  _withTimeout: withTimeout,
  _classifyError: classifyError,
};
