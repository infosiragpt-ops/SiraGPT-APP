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
const relevance = require('./relevance');
const queryIntelligence = require('./query-intelligence');

// Detected query language → a locale providers understand (Wikipedia language,
// DuckDuckGo `kl` region). Used only when the caller didn't pass an explicit
// locale, so the chat path automatically searches the right-language sources.
const LANG_LOCALE = { es: 'es-es', en: 'en-us' };

const DEFAULT_TIMEOUT_MS = 3000;
// The aggregating `searchMany` path fans out to many providers in parallel and
// waits for all of them (bounded by this per-provider deadline), so it uses a
// tighter default than single-provider `search()` to keep the chat snappy —
// one slow public instance can't drag the whole turn past ~2.5s. Env-tunable.
const DEFAULT_MANY_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_WEBSEARCH_MANY_TIMEOUT_MS || '', 10) || 2500;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX = 200;

// Providers that query academic/paper databases. They are authoritative for
// research questions but must NOT be consulted for casual prompts — otherwise
// a query like "¿qué día es hoy?" gets answered with random DOIs. `searchMany`
// only includes this tier when the query looks scientific.
const SCIENTIFIC_PROVIDER_IDS = new Set([
  'crossref', 'pubmed', 'scielo', 'openalex', 'arxiv', 'europepmc',
]);

// Lightweight heuristic: does the prompt look like an academic/research ask?
// Unicode-aware boundaries so accented Spanish keywords match (needs `u`).
const SCIENTIFIC_QUERY_RE = /(?<![\p{L}])(?:estudios?|investigaci[oó]n(?:es)?|paper|papers|journal|revista[s]?\s+cient[ií]fica[s]?|cient[ií]fic[ao]s?|cl[ií]nic[ao]s?|clinical|trial|ensayo[s]?\s+cl[ií]nico[s]?|evidencia\s+cient[ií]fica|hip[oó]tesis|hypothesis|meta[\s-]?an[aá]lisis|meta[\s-]?analysis|systematic\s+review|revisi[oó]n\s+sistem[aá]tica|doi|pubmed|arxiv|scielo|crossref|openalex|teorema|experiment(?:o|os|al)?|dataset|biomarcador(?:es)?|peer[\s-]?review)(?![\p{L}])/iu;

function isScientificQuery(query) {
  return SCIENTIFIC_QUERY_RE.test(String(query || ''));
}

const builtinProviders = [
  // Scientific tier (priority 3-7) — try the most authoritative sources
  // first. Each returns [] when the query has no scientific match, so
  // the adapter falls through cleanly to the general-web tier.
  require('./providers/crossref'),
  require('./providers/pubmed'),
  require('./providers/scielo'),
  require('./providers/openalex'),
  require('./providers/arxiv'),
  require('./providers/europepmc'),
  // General-web tier (priority 8-30). Brave (priority 8) leads when its
  // optional BRAVE_SEARCH_API_KEY is set; otherwise it reports
  // enabled:false and the chain falls through to the free, key-less
  // DuckDuckGo → Stack Exchange → Hacker News → Wikipedia → SearXNG
  // providers. The extra key-less providers widen breadth for the
  // aggregating `searchMany` path (tech Q&A + tech news) and stay cheap
  // for `search()` since each returns [] when it has no match.
  require('./providers/brave'),
  require('./providers/duckduckgo'),
  require('./providers/stackexchange'),
  require('./providers/hackernews'),
  require('./providers/github'),
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
// Separate cache for the aggregating `searchMany` path so its merged,
// relevance-ranked payloads never collide with single-provider `search()`.
// Longer TTL + larger capacity because it backs a stale-while-revalidate
// strategy: a cached turn is served in microseconds and refreshed in the
// background once it ages past SWR_FRESH_MS.
const SWR_TTL_MS = Number.parseInt(process.env.SIRAGPT_WEBSEARCH_CACHE_TTL_MS || '', 10) || 30 * 60 * 1000;
const SWR_FRESH_MS = Number.parseInt(process.env.SIRAGPT_WEBSEARCH_CACHE_FRESH_MS || '', 10) || 3 * 60 * 1000;
const SWR_CACHE_MAX = Number.parseInt(process.env.SIRAGPT_WEBSEARCH_CACHE_MAX || '', 10) || 400;
const manyCache = new LruTtlCache({ max: SWR_CACHE_MAX, ttlMs: SWR_TTL_MS });

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
  // Optional time-freshness hint (e.g. "pw" / "last week"). Only some
  // providers honour it (Brave); the rest ignore the extra opt harmlessly.
  const freshness = typeof opts.freshness === 'string' && opts.freshness.trim() ? opts.freshness.trim() : null;
  const includeNews = opts.includeNews === true;
  const includeScientific = opts.includeScientific === true
    || (opts.includeScientific !== false && isScientificQuery(q));
  // Fresh queries must not return a stale cache entry, so fold the
  // freshness hint into the cache bucket WITHOUT touching the cache's
  // (query, locale) signature or the real locale passed to providers.
  const cacheBucket = [locale || '', freshness ? `f=${freshness}` : '', includeNews ? 'news' : '', includeScientific ? 'sci' : '']
    .filter(Boolean).join('|') || null;

  const cached = cache.get(q, cacheBucket);
  if (cached) {
    return {
      results: cached.results.slice(0, maxResults),
      provider: cached.provider,
      cached: true,
      attempts: [],
    };
  }

  const attempts = [];
  // General prompts must not be hijacked by academic APIs (OpenAlex/Crossref
  // can return loosely-related papers for almost any phrase). Keep the
  // scientific tier for explicit research asks only, mirroring searchMany().
  const selected = providers.filter(
    (p) => includeScientific || !SCIENTIFIC_PROVIDER_IDS.has(p.id),
  );
  for (const p of selected) {
    const start = Date.now();
    try {
      const results = await withTimeout(
        (signal) => p.search(q, { maxResults, locale, signal, freshness, includeNews }),
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
      cache.set(q, cacheBucket, value);
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

// ── aggregating entry point ──────────────────────────────────────────
// Unlike `search()` (first non-empty provider wins), `searchMany()` fans out
// to ALL relevant providers IN PARALLEL, merges + de-duplicates their results
// and ranks them by relevance to the query, dropping anything irrelevant.
//
// This is what powers the chat "Fuentes" panel: more sources (aggregated
// across providers), faster (parallel ≈ slowest provider, not the sum), and
// higher quality (irrelevant academic papers are filtered out instead of
// hijacking casual prompts).
async function searchMany(query, opts = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) {
    return { results: [], provider: null, providers: [], cached: false, attempts: [] };
  }

  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 30, 1000));
  // Locale: caller's explicit value wins; otherwise detect the query language
  // and search the matching-language sources automatically.
  const explicitLocale = typeof opts.locale === 'string' ? opts.locale : null;
  const locale = explicitLocale || LANG_LOCALE[queryIntelligence.detectLanguage(q)] || null;
  const timeoutMs = Math.max(500, Math.min(Number(opts.timeoutMs) || DEFAULT_MANY_TIMEOUT_MS, 10000));
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.3;
  const includeScientific = opts.includeScientific === true
    || (opts.includeScientific !== false && isScientificQuery(q));
  // Optional multi-query fan-out: run synonym-expanded query variants for more
  // recall. Default 1 (no extra network) so the latency-sensitive chat path is
  // unchanged; callers opt in with `fanout:true` or `variants:N`.
  const variantCount = Math.max(1, Math.min(Number(opts.variants) || (opts.fanout ? 3 : 1), 4));
  const searchQueries = variantCount > 1
    ? queryIntelligence.queryVariants(q, { max: variantCount })
    : [q];

  // A query with no discriminating content tokens (e.g. "¿qué día es hoy?")
  // can't be matched against any source — skip the network entirely.
  if (relevance.contentTokens(q).length === 0) {
    return { results: [], provider: null, providers: [], cached: false, attempts: [] };
  }

  // Fold the result-shaping opts (fan-out width + relevance floor) into the key
  // so a differently-configured call can't be served another bucket's payload.
  // For all current callers these are constants (1 / 0.3), so the happy-path
  // cache hit/miss and returned results are byte-identical.
  const cacheKey = `${includeScientific ? 'sci' : 'gen'}:${maxResults}:${variantCount}:${minScore}:${q}`;

  // Stale-while-revalidate: serve a cached payload instantly; if it has aged
  // past the freshness window, kick off a non-blocking background refresh so
  // the NEXT turn is current — the user never waits on the network.
  if (opts._force !== true) {
    const cachedHit = manyCache.get(cacheKey, locale);
    if (cachedHit) {
      const age = Date.now() - (cachedHit.at || 0);
      if (age > SWR_FRESH_MS && opts._background !== true) {
        Promise.resolve()
          .then(() => searchMany(query, { ...opts, _force: true, _background: true }))
          .catch(() => { /* best-effort refresh */ });
      }
      return {
        results: cachedHit.results.slice(0, maxResults),
        provider: cachedHit.provider,
        providers: cachedHit.providers,
        cached: true,
        attempts: [],
      };
    }
  }

  // General tier always runs; scientific tier only for research-y queries.
  const selected = providers.filter(
    (p) => includeScientific || !SCIENTIFIC_PROVIDER_IDS.has(p.id),
  );
  // Ask each provider for a generous page; they self-clamp to their own max
  // (DDG ~15, Wikipedia ~10, OpenAlex/Crossref up to 50-60), which is how the
  // aggregate reaches hundreds of candidates for broad/scientific queries.
  const perProvider = Math.max(5, Math.min(maxResults, 50));

  // Fan out across (provider × query-variant) in parallel.
  const tasks = [];
  for (const p of selected) {
    for (const sq of searchQueries) tasks.push({ p, sq });
  }
  const attempts = [];
  const settled = await Promise.allSettled(
    tasks.map(async ({ p, sq }) => {
      const start = Date.now();
      try {
        const results = await withTimeout(
          (signal) => p.search(sq, { maxResults: perProvider, locale, signal }),
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
        attempts.push({ id: p.id, ok: true, ms: Date.now() - start, count: normalised.length, variant: sq !== q || undefined });
        return normalised;
      } catch (err) {
        attempts.push({ id: p.id, ok: false, ms: Date.now() - start, error: classifyError(err), variant: sq !== q || undefined });
        return [];
      }
    }),
  );

  const merged = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) merged.push(...s.value);
  }

  // Diversity: cap results per domain for general-web queries so one site
  // can't dominate; scientific queries skip the cap (each doi.org/arxiv path
  // is a distinct paper). Aggregator hosts are exempt inside rankAndFilter.
  const perDomain = includeScientific
    ? undefined
    : (Number.parseInt(process.env.SIRAGPT_WEBSEARCH_PER_DOMAIN || '', 10) || 6);

  const ranked = relevance
    .rankAndFilter(q, merged, { minScore, limit: maxResults, perDomain })
    // eslint-disable-next-line no-unused-vars
    .map(({ _score, _rank, ...rest }) => rest);

  const providersUsed = Array.from(new Set(ranked.map((r) => r.source))).slice(0, 12);
  const provider = providersUsed.length ? `aggregate:${providersUsed.length}` : null;

  if (ranked.length > 0) {
    manyCache.set(cacheKey, locale, { results: ranked, provider, providers: providersUsed, at: Date.now() });
  }

  // Audit WITHOUT the raw query (only its length) — same rule as search().
  auditLog.audit({
    event: 'web_search_many',
    provider,
    hits: ranked.length,
    queryLen: q.length,
    locale: locale || null,
    scientific: includeScientific,
    attempts: attempts.map(({ id, ok, ms, count, error }) => ({ id, ok, ms, count, error })),
    cached: false,
  });

  return { results: ranked, provider, providers: providersUsed, cached: false, attempts };
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

function clearCache() { cache.clear(); manyCache.clear(); }

module.exports = {
  search,
  searchMany,
  isScientificQuery,
  setProviders,
  getProviders,
  resetProviders,
  clearCache,
  SCIENTIFIC_PROVIDER_IDS,
  // exported for tests
  _cache: cache,
  _manyCache: manyCache,
  _LruTtlCache: LruTtlCache,
  _withTimeout: withTimeout,
  _classifyError: classifyError,
};
