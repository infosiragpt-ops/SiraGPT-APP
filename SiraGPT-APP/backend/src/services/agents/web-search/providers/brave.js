/**
 * brave — Brave Search API. Optional, key-gated, production-hardened.
 *
 * Endpoint: https://api.search.brave.com/res/v1/web/search?q=…
 * Auth:     header `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>`
 *
 * Brave is the only general-web provider in the chain that needs a key, so
 * it is gated on `BRAVE_SEARCH_API_KEY`. When the key is absent the provider
 * reports `enabled === false` and the adapter silently skips it, falling
 * through to the free, key-less DuckDuckGo → Wikipedia → SearXNG tier. When
 * the key IS present Brave runs at the head of the general-web tier
 * (priority 8) because it returns the freshest, highest-quality results.
 *
 * Hardening over the v1 provider:
 *   - Transient-only retry (`withRetry`): 429/5xx/network/timeout are retried
 *     with full-jitter backoff; other 4xx (incl. 401/403 auth) never are.
 *   - `freshness` time filter (pd/pw/pm/py or an ISO date range) so the agent
 *     can ask for "the last week" — threaded end-to-end from the web_search
 *     tool through the adapter.
 *   - `extra_snippets` merged into the snippet for richer context.
 *   - Optional `news` results folded in when freshness/news is requested.
 *   - An internal abort timeout for DIRECT calls (the adapter already wraps
 *     provider calls in its own per-provider timeout + signal).
 *
 * Returns `[]` (not a throw) when the response carries no results so the
 * adapter treats it as "try next provider".
 */

const fetch = require('node-fetch');
const { withRetry } = require('../../../../utils/retry-with-backoff');

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';
const DEFAULT_TIMEOUT_MS = 6000;

function braveKey() {
  const raw = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY || '';
  const key = String(raw).trim();
  return key.length > 0 ? key : null;
}

function hasBraveKey() {
  return braveKey() !== null;
}

class BraveHttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.name = 'BraveHttpError';
    this.status = status;
    this.retryAfter = retryAfter || null;
  }
}

// Brave wants `search_lang` (lowercase ISO-639-1) + `country` (2-letter
// ISO-3166). Derive both from a locale like "es-ES" / "es" / "en".
function localeToParams(locale, params) {
  if (typeof locale !== 'string') return;
  const m = locale.match(/^([a-z]{2})(?:[-_]([a-z]{2}))?$/i);
  if (!m) return;
  params.set('search_lang', m[1].toLowerCase());
  if (m[2]) params.set('country', m[2].toUpperCase());
}

// Brave `freshness`: pd|pw|pm|py OR an explicit `YYYY-MM-DDtoYYYY-MM-DD`
// range. Accept friendly aliases (day/week/month/year, bilingual) too.
const FRESHNESS_ALIASES = {
  pd: 'pd', d: 'pd', day: 'pd', today: 'pd', 'día': 'pd', dia: 'pd', hoy: 'pd',
  pw: 'pw', w: 'pw', week: 'pw', semana: 'pw',
  pm: 'pm', m: 'pm', month: 'pm', mes: 'pm',
  py: 'py', y: 'py', year: 'py', ano: 'py', 'año': 'py',
};
function normaliseFreshness(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (FRESHNESS_ALIASES[v]) return FRESHNESS_ALIASES[v];
  // explicit date range, e.g. 2024-01-01to2024-03-31
  if (/^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

// Retry policy: Brave's API has transient modes (429 rate limit, 5xx, network
// blips) that resolve on a second try; never retry other 4xx (auth/quota).
// Tunable / disable-able via env so ops can dial it back without a deploy.
function classifyBraveError(err) {
  const status = err && Number(err.status);
  if (status === 429 || (Number.isFinite(status) && status >= 500)) {
    return { retryable: true, reason: `http_${status}` };
  }
  if (Number.isFinite(status) && status >= 400) {
    return { retryable: false, reason: `http_${status}` };
  }
  const msg = String((err && err.message) || '').toLowerCase();
  if (/abort/.test(msg)) return { retryable: false, reason: 'aborted' };
  if (/timed out|timeout/.test(msg)) return { retryable: true, reason: 'timeout' };
  if (/network|enotfound|econnreset|econnrefused|eai_again|fetch failed|getaddrinfo/.test(msg)) {
    return { retryable: true, reason: 'network' };
  }
  return { retryable: false, reason: 'unknown' };
}

function retryConfig() {
  const disabled = String(process.env.BRAVE_SEARCH_RETRY_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true' || disabled === 'yes') return { maxRetries: 0 };
  const envRetries = Number.parseInt(process.env.BRAVE_SEARCH_MAX_RETRIES, 10);
  const envBase = Number.parseInt(process.env.BRAVE_SEARCH_RETRY_BASE_MS, 10);
  const maxRetries = Number.isFinite(envRetries) && envRetries >= 0 ? envRetries : 1;
  const baseDelayMs = Number.isFinite(envBase) && envBase > 0 ? envBase : 250;
  return { maxRetries: Math.max(0, Math.min(maxRetries, 4)), baseDelayMs };
}

async function braveFetchOnce(url, { signal, key }) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': key,
    },
    signal,
  });
  if (!res.ok) {
    const retryAfter = res.headers?.get?.('retry-after');
    throw new BraveHttpError(res.status, `brave http ${res.status}`, retryAfter);
  }
  return res.json();
}

function braveFetch(url, opts) {
  const cfg = retryConfig();
  if (!cfg.maxRetries) return braveFetchOnce(url, opts);
  return withRetry(() => braveFetchOnce(url, opts), {
    maxRetries: cfg.maxRetries,
    baseDelayMs: cfg.baseDelayMs,
    maxDelayMs: 2000,
    classifyError: classifyBraveError,
    ...(typeof opts.sleep === 'function' ? { sleep: opts.sleep } : {}),
  });
}

async function search(query, { maxResults = 5, signal, locale, freshness, includeNews } = {}) {
  const key = braveKey();
  // Defensive: the adapter already skips disabled providers, but guard here
  // too so a direct call never leaks an unauthenticated request.
  if (!key) return [];
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];

  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 20));
  const fresh = normaliseFreshness(freshness);
  const wantNews = includeNews === true || fresh != null;

  const params = new URLSearchParams({
    q,
    count: String(limit),
    safesearch: 'moderate',
    result_filter: wantNews ? 'web,news' : 'web',
    text_decorations: '0',
    spellcheck: '1',
    extra_snippets: '1',
  });
  if (fresh) params.set('freshness', fresh);
  localeToParams(locale, params);

  // The adapter wraps provider calls in its own timeout + AbortSignal. Only
  // create our own timeout for DIRECT callers that pass no signal.
  let timeoutHandle = null;
  let effectiveSignal = signal;
  if (!effectiveSignal) {
    const ctrl = new AbortController();
    effectiveSignal = ctrl.signal;
    const ms = Number.parseInt(process.env.BRAVE_SEARCH_TIMEOUT_MS, 10);
    timeoutHandle = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* noop */ } },
      Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS);
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  }

  try {
    const body = await braveFetch(`${ENDPOINT}?${params.toString()}`, { signal: effectiveSignal, key });
    return mapResults(body, limit, { includeNews: wantNews });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function mapResults(body, maxResults = 5, { includeNews = false } = {}) {
  const out = [];
  const seen = new Set();
  const push = (it, kind) => {
    if (out.length >= maxResults) return;
    const url = it?.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const extras = Array.isArray(it?.extra_snippets) ? it.extra_snippets.join(' ') : '';
    const snippet = stripTags(`${it?.description || ''} ${extras}`).trim();
    out.push({
      title: (stripTags(String(it?.title || url)).trim() || url).slice(0, 240),
      url,
      snippet: snippet.slice(0, 600),
      source: kind === 'news' ? 'brave-news' : 'brave',
      ...(it?.age ? { age: String(it.age).slice(0, 40) } : {}),
    });
  };

  const web = Array.isArray(body?.web?.results) ? body.web.results : [];
  for (const it of web) push(it, 'web');
  if (includeNews) {
    const news = Array.isArray(body?.news?.results) ? body.news.results : [];
    for (const it of news) push(it, 'news');
  }
  return out;
}

// Brave can return light HTML (<strong> highlights) inside title/description
// even with text_decorations=0 on some endpoints — strip defensively.
function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  id: 'brave',
  name: 'Brave Search',
  priority: 8,
  // Gated on the API key so the adapter skips it cleanly when unset.
  get enabled() {
    return hasBraveKey();
  },
  search,
  _internal: {
    mapResults, stripTags, hasBraveKey, braveKey, localeToParams,
    normaliseFreshness, classifyBraveError, retryConfig, BraveHttpError,
  },
};
