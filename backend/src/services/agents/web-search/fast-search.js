'use strict';

/**
 * Búsqueda rápida — the default low-latency web search engine for agents.
 *
 * One call returns ranked, de-duplicated, structured results (title, url,
 * snippet, date, domain, favicon) as fast as the fastest configured provider
 * can answer:
 *
 *   1. Normalise the query and consult the two-tier cache (in-process LRU,
 *      then Redis when REDIS_URL is set). Hits answer in microseconds and do
 *      not count against the per-user rate limit.
 *   2. Race a provider ladder with *hedging*: the first rung starts at once;
 *      if it has not answered within `hedgeMs` (800 ms) the next rung starts
 *      in parallel, and an empty/failed rung escalates immediately. The first
 *      non-empty answer wins and every other in-flight request is aborted.
 *      Ladder: Perplexity Search → Brave → Tavily → Exa (each only when its
 *      key exists) → the free key-less aggregate (DuckDuckGo, Wikipedia,
 *      Stack Exchange…, via web-search.searchMany) which is always last.
 *   3. Canonicalise URLs (tracking params, www, trailing slash), drop
 *      duplicates, apply domain allow/deny filters and a per-domain cap.
 *   4. Record latency per provider (ring buffer → p50/p95) for
 *      GET /api/admin/health/web-search, and audit without the raw query.
 *
 * The academic multi-database path (task-tools web_search → runAgenticBatch)
 * is intentionally separate: that is deep research, this is the fast lookup.
 */

const { createHash } = require('node:crypto');
const auditLog = require('../audit-log');
const perplexity = require('./providers/perplexity');
const brave = require('./providers/brave');

const HEDGE_MS = Number.parseInt(process.env.SIRAGPT_FAST_SEARCH_HEDGE_MS || '', 10) || 800;
const PREMIUM_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_FAST_SEARCH_PROVIDER_TIMEOUT_MS || '', 10) || 2500;
const FREE_TIMEOUT_MS = Number.parseInt(process.env.SIRAGPT_FAST_SEARCH_FREE_TIMEOUT_MS || '', 10) || 3000;
const DEADLINE_MS = Number.parseInt(process.env.SIRAGPT_FAST_SEARCH_DEADLINE_MS || '', 10) || 6000;
const USER_RPM = Number.parseInt(process.env.SIRAGPT_FAST_SEARCH_USER_RPM || '', 10) || 60;
const MEMORY_MAX = 500;
const METRIC_SAMPLES = 500;
const REDIS_GET_BUDGET_MS = 120;
const PER_DOMAIN_CAP = 3;

// ── query + url normalisation ───────────────────────────────────────────
function normalizeQuery(query) {
  return String(query || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[¿¡\s]+/, '')
    .replace(/[?!.\s]+$/, '')
    .slice(0, 400);
}

const TRACKING_PARAM_RE = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|ref|ref_src|igshid|si)$/i;

function canonicalUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    let out = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}`;
    const qs = u.searchParams.toString();
    if (qs) out += `?${qs}`;
    return out.toLowerCase();
  } catch (_) {
    return null;
  }
}

function domainOf(raw) {
  try { return new URL(String(raw)).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}

function normalizeDomainList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    .slice(0, 20);
}

function matchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function shapeResults(list, { maxResults, domains, excludeDomains, provider }) {
  const seen = new Set();
  const perDomain = new Map();
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.url !== 'string' || typeof r.title !== 'string') continue;
    const canon = canonicalUrl(r.url);
    if (!canon || seen.has(canon)) continue;
    const domain = domainOf(r.url);
    if (!domain) continue;
    if (domains.length && !domains.some((d) => matchesDomain(domain, d))) continue;
    if (excludeDomains.some((d) => matchesDomain(domain, d))) continue;
    const used = perDomain.get(domain) || 0;
    // Explicit allow-lists mean the caller wants that site: no diversity cap.
    if (!domains.length && used >= PER_DOMAIN_CAP) continue;
    seen.add(canon);
    perDomain.set(domain, used + 1);
    out.push({
      title: String(r.title).replace(/\s+/g, ' ').trim().slice(0, 240) || domain,
      url: r.url,
      snippet: String(r.snippet || r.content || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      ...(r.date || r.age ? { date: String(r.date || r.age).slice(0, 40) } : {}),
      domain,
      favicon: `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`,
      source: r.source || provider,
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

// ── provider ladder ─────────────────────────────────────────────────────
async function tavilySearch(query, { maxResults, freshness, domains, excludeDomains, signal, fetchImpl = globalThis.fetch }) {
  const key = String(process.env.TAVILY_API_KEY || '').trim();
  if (!key) return [];
  const days = { pd: 1, day: 1, pw: 7, week: 7, pm: 31, month: 31, py: 365, year: 365 }[String(freshness || '').toLowerCase()];
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      max_results: Math.min(maxResults, 20),
      search_depth: 'basic',
      ...(days ? { days, topic: days <= 7 ? 'news' : 'general' } : {}),
      ...(domains.length ? { include_domains: domains } : {}),
      ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`tavily http ${res.status}`);
  const body = await res.json();
  return (body.results || []).map((r) => ({
    title: r.title || r.url, url: r.url, snippet: r.content || '',
    ...(r.published_date ? { date: r.published_date } : {}), source: 'tavily',
  }));
}

async function exaSearch(query, { maxResults, domains, excludeDomains, signal, fetchImpl = globalThis.fetch }) {
  const key = String(process.env.EXA_API_KEY || '').trim();
  if (!key) return [];
  const res = await fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      numResults: Math.min(maxResults, 20),
      type: 'fast',
      contents: { highlights: { numSentences: 2 } },
      ...(domains.length ? { includeDomains: domains } : {}),
      ...(excludeDomains.length ? { excludeDomains } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`exa http ${res.status}`);
  const body = await res.json();
  return (body.results || []).map((r) => ({
    title: r.title || r.url, url: r.url,
    snippet: Array.isArray(r.highlights) && r.highlights.length ? r.highlights.join(' ') : (r.text || ''),
    ...(r.publishedDate ? { date: r.publishedDate } : {}), source: 'exa',
  }));
}

async function freeAggregateSearch(query, { maxResults, locale, freshness, signal }) {
  // eslint-disable-next-line global-require
  const webSearch = require('./index');
  if (signal?.aborted) return [];
  const out = await webSearch.searchMany(query, {
    maxResults: Math.max(maxResults, 8),
    locale,
    freshness: freshness || undefined,
    timeoutMs: Math.max(800, FREE_TIMEOUT_MS - 300),
  });
  const list = (out?.results || []).map((r) => ({ ...r, source: r.source || 'free' }));
  // Keep the aggregate's own label ("aggregate:3") for callers and audits.
  if (out?.provider) Object.defineProperty(list, 'provider', { value: out.provider, enumerable: false });
  return list;
}

const LADDER = [
  { id: 'perplexity', tier: 'premium', enabled: () => perplexity.enabled, run: (q, o) => perplexity.search(q, o) },
  { id: 'brave', tier: 'premium', enabled: () => brave.enabled, run: (q, o) => brave.search(q, { ...o, includeNews: Boolean(o.freshness) }) },
  { id: 'tavily', tier: 'premium', enabled: () => Boolean(String(process.env.TAVILY_API_KEY || '').trim()), run: tavilySearch },
  { id: 'exa', tier: 'premium', enabled: () => Boolean(String(process.env.EXA_API_KEY || '').trim()), run: exaSearch },
  { id: 'free', tier: 'free', enabled: () => true, run: freeAggregateSearch },
];

function configuredProviders() {
  return LADDER.filter((p) => p.enabled()).map((p) => p.id);
}

// ── hedged race ─────────────────────────────────────────────────────────
function classify(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (/timeout/.test(msg)) return 'timeout';
  if (/abort/.test(msg)) return 'aborted';
  const m = msg.match(/http\s*(\d{3})/);
  if (m) return Number(m[1]) >= 500 ? 'http_5xx' : (m[1] === '429' ? 'rate_limited' : 'http_4xx');
  return 'error';
}

function runWithTimeout(fn, ms, parentSignal) {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`timeout after ${ms}ms`)); ctrl.abort(); }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return {
    ctrl,
    promise: Promise.race([Promise.resolve().then(() => fn(ctrl.signal)), timeout]).finally(() => {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }),
  };
}

/**
 * Race `ladder` rungs with hedging. Resolves `{ provider, results, attempts }`
 * for the first non-empty rung, or `{ provider: null, results: [], attempts }`.
 */
function hedgedRace(ladder, execute, { hedgeMs = HEDGE_MS, deadlineMs = DEADLINE_MS, signal } = {}) {
  return new Promise((resolve) => {
    const attempts = [];
    const inflight = new Map();
    let next = 0;
    let settled = false;
    let hedgeTimer = null;
    let deadlineTimer = null;

    const finish = (winner) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(deadlineTimer);
      for (const [id, ctrl] of inflight) {
        try { ctrl.abort(); } catch (_) { /* noop */ }
        attempts.push({ id, ok: false, ms: null, error: 'cancelled' });
      }
      inflight.clear();
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ provider: winner?.provider || null, results: winner?.results || [], attempts });
    };
    const onAbort = () => finish(null);

    const launch = () => {
      if (settled) return;
      if (next >= ladder.length) {
        if (inflight.size === 0) finish(null);
        return;
      }
      const rung = ladder[next++];
      const start = Date.now();
      const { ctrl, promise } = execute(rung);
      inflight.set(rung.id, ctrl);
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, hedgeMs);
      if (typeof hedgeTimer.unref === 'function') hedgeTimer.unref();
      promise.then((results) => {
        if (settled) return;
        inflight.delete(rung.id);
        const list = Array.isArray(results) ? results : [];
        attempts.push({ id: rung.id, ok: true, ms: Date.now() - start, count: list.length });
        if (list.length) finish({ provider: list.provider || rung.id, results: list });
        else launch();
      }, (err) => {
        if (settled) return;
        inflight.delete(rung.id);
        attempts.push({ id: rung.id, ok: false, ms: Date.now() - start, error: classify(err) });
        launch();
      });
    };

    if (signal) {
      if (signal.aborted) { finish(null); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    deadlineTimer = setTimeout(() => finish(null), deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    launch();
  });
}

// ── caches ──────────────────────────────────────────────────────────────
const memory = new Map();

function memoryGet(key, now = Date.now()) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (now > hit.expiresAt) { memory.delete(key); return null; }
  memory.delete(key);
  memory.set(key, hit);
  return hit.value;
}

function memorySet(key, value, ttlMs, now = Date.now()) {
  memory.delete(key);
  memory.set(key, { value, expiresAt: now + ttlMs });
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
}

let redisStore;
function getRedisStore() {
  if (redisStore !== undefined) return redisStore;
  try {
    // eslint-disable-next-line global-require
    const { createRedisStore } = require('../../../cache/RedisStore');
    redisStore = createRedisStore(process.env, { prefix: 'sira:fastsearch:v1:' });
  } catch (_) {
    redisStore = null;
  }
  return redisStore;
}

async function redisGet(store, key) {
  if (!store) return null;
  let timer;
  try {
    return await Promise.race([
      store.get(key).then((v) => v || null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), REDIS_GET_BUDGET_MS); }),
    ]);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cacheTtlMs(freshness) {
  const f = String(freshness || '').toLowerCase();
  if (f === 'pd' || f === 'day') return 90 * 1000;
  if (f === 'pw' || f === 'week') return 5 * 60 * 1000;
  return 10 * 60 * 1000;
}

// ── per-user rate limit (sliding window) ────────────────────────────────
const userWindows = new Map();

function allowUser(userKey, limit = USER_RPM, now = Date.now()) {
  const windowStart = now - 60 * 1000;
  const list = (userWindows.get(userKey) || []).filter((t) => t > windowStart);
  if (list.length >= limit) {
    userWindows.set(userKey, list);
    return false;
  }
  list.push(now);
  userWindows.set(userKey, list);
  if (userWindows.size > 5000) userWindows.delete(userWindows.keys().next().value);
  return true;
}

// ── metrics ─────────────────────────────────────────────────────────────
const samples = [];
const counters = { calls: 0, memoryHits: 0, redisHits: 0, rateLimited: 0, empty: 0 };

function recordSample(sample) {
  samples.push({ ...sample, at: Date.now() });
  if (samples.length > METRIC_SAMPLES) samples.shift();
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(list) {
  const ms = list.map((s) => s.ms).filter((v) => Number.isFinite(v));
  return { count: list.length, p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95) };
}

function getMetrics() {
  const network = samples.filter((s) => !s.cached);
  const byProvider = {};
  for (const s of network) {
    const id = s.provider || 'none';
    (byProvider[id] = byProvider[id] || []).push(s);
  }
  const providers = {};
  for (const [id, list] of Object.entries(byProvider)) providers[id] = summarize(list);
  return {
    engine: 'fast-search',
    configured: configuredProviders(),
    hedgeMs: HEDGE_MS,
    overall: summarize(samples),
    network: summarize(network),
    providers,
    counters: { ...counters },
    cache: { memoryEntries: memory.size, redis: Boolean(getRedisStore()) },
    sampleWindow: samples.length,
  };
}

// ── entry point ─────────────────────────────────────────────────────────
async function fastSearch(query, opts = {}) {
  const started = Date.now();
  const q = normalizeQuery(query);
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 8, 20));
  const empty = (extra = {}) => ({ query: q, results: [], provider: null, providers: [], cached: false, latencyMs: Date.now() - started, attempts: [], ...extra });
  if (q.length < 2) return empty();

  counters.calls += 1;
  const locale = typeof opts.locale === 'string' && opts.locale.trim() ? opts.locale.trim() : null;
  const freshness = typeof opts.freshness === 'string' && opts.freshness.trim() ? opts.freshness.trim().toLowerCase() : null;
  const domains = normalizeDomainList(opts.domains);
  const excludeDomains = normalizeDomainList(opts.excludeDomains);
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([q.toLowerCase(), locale, freshness, domains, excludeDomains, maxResults]))
    .digest('hex')
    .slice(0, 40);

  const fromMemory = memoryGet(cacheKey);
  if (fromMemory) {
    counters.memoryHits += 1;
    const latencyMs = Date.now() - started;
    recordSample({ ms: latencyMs, provider: fromMemory.provider, cached: true });
    return { ...fromMemory, cached: true, latencyMs, attempts: [] };
  }
  const store = opts.redis !== undefined ? opts.redis : getRedisStore();
  const fromRedis = await redisGet(store, cacheKey);
  if (fromRedis && Array.isArray(fromRedis.results)) {
    counters.redisHits += 1;
    memorySet(cacheKey, fromRedis, cacheTtlMs(freshness));
    const latencyMs = Date.now() - started;
    recordSample({ ms: latencyMs, provider: fromRedis.provider, cached: true });
    return { ...fromRedis, cached: true, latencyMs, attempts: [] };
  }

  const userKey = String(opts.userId || 'anon');
  if (!allowUser(userKey, opts.userRpm || USER_RPM)) {
    counters.rateLimited += 1;
    return empty({
      rateLimited: true,
      note: 'Límite de búsquedas por minuto alcanzado. Espera unos segundos o reutiliza los resultados anteriores.',
    });
  }

  const ladder = (Array.isArray(opts.ladder) ? opts.ladder : LADDER).filter((p) => p.enabled());
  const runOpts = { maxResults, locale, freshness, domains, excludeDomains };
  const raced = await hedgedRace(
    ladder,
    (rung) => runWithTimeout(
      (signal) => rung.run(q, { ...runOpts, signal }),
      rung.tier === 'free' ? FREE_TIMEOUT_MS : PREMIUM_TIMEOUT_MS,
      opts.signal,
    ),
    { hedgeMs: opts.hedgeMs ?? HEDGE_MS, deadlineMs: opts.deadlineMs ?? DEADLINE_MS, signal: opts.signal },
  );

  const results = shapeResults(raced.results, { maxResults, domains, excludeDomains, provider: raced.provider });
  const latencyMs = Date.now() - started;
  const providers = Array.from(new Set(results.map((r) => r.source))).slice(0, 8);
  const payload = { query: q, results, provider: raced.provider, providers };
  recordSample({ ms: latencyMs, provider: raced.provider, cached: false });
  if (!results.length) counters.empty += 1;

  if (results.length) {
    const ttl = cacheTtlMs(freshness);
    memorySet(cacheKey, payload, ttl);
    if (store) store.set(cacheKey, payload, ttl).catch(() => {});
  }

  try {
    auditLog.audit({
      event: 'web_search_fast',
      provider: raced.provider,
      hits: results.length,
      durationMs: latencyMs,
      queryLen: q.length,
      locale,
      attempts: raced.attempts.map(({ id, ok, ms, count, error }) => ({ id, ok, ms, count, error })),
      cached: false,
    });
  } catch (_) { /* audit is best effort */ }

  return { ...payload, cached: false, latencyMs, attempts: raced.attempts };
}

function _resetForTests() {
  memory.clear();
  userWindows.clear();
  samples.length = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
  redisStore = undefined;
}

module.exports = {
  fastSearch,
  getMetrics,
  configuredProviders,
  LADDER,
  _internal: {
    normalizeQuery, canonicalUrl, shapeResults, hedgedRace, runWithTimeout,
    allowUser, percentile, cacheTtlMs, normalizeDomainList, _resetForTests,
  },
};
