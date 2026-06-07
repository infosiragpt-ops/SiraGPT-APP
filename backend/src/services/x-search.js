'use strict';

/**
 * x-search — real-time X (Twitter) search via xAI's Live Search API.
 *
 * xAI exposes "Live Search" as a `search_parameters` field on the
 * OpenAI-compatible `/chat/completions` endpoint. Forcing
 * `mode: 'on'` + `sources: [{ type: 'x' }]` + `return_citations: true`
 * turns Grok into a live X/Twitter retriever: the model summarises the
 * most relevant recent posts and the response carries a top-level
 * `citations` array of the source post URLs.
 *
 * Key-gated on `XAI_API_KEY`. With no key the module degrades gracefully —
 * `isConfigured()` is false and `search()` returns an empty, annotated
 * result WITHOUT touching the network — so the agent loop can register the
 * `x_search` tool unconditionally and simply report that it needs
 * configuration when the user asks for X results.
 *
 * Production hardening:
 *   - Transient-only retry (`withRetry`): 429/5xx/network/timeout retried
 *     with full-jitter backoff; other 4xx (incl. 401/403 auth) never are.
 *   - Optional extra sources (web / news) alongside X.
 *   - In-memory metrics (searches / posts / error codes) for observability.
 *   - `fetchImpl` injectable so the whole thing is testable offline.
 */

const { DEFAULT_XAI_BASE_URL, DEFAULT_XAI_CHAT_MODEL } = require('./xai-audio');
const { withRetry } = require('../utils/retry-with-backoff');
const metrics = require('./x-search-metrics');

const UNCONFIGURED_NOTE =
  'X (Twitter) search is unavailable: set XAI_API_KEY (xAI Live Search) to enable real-time X results.';

const ALLOWED_SOURCES = new Set(['x', 'web', 'news', 'rss']);

class XSearchHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'XSearchHttpError';
    this.status = status;
  }
}

function resolveXaiProvider(env = process.env) {
  const apiKey = String(env.XAI_API_KEY || '').trim();
  if (!apiKey) {
    return { configured: false, apiKey: null, baseUrl: null, model: env.XAI_GROK_MODEL || DEFAULT_XAI_CHAT_MODEL };
  }
  const baseUrl = String(env.XAI_API_BASE_URL || env.XAI_BASE_URL || DEFAULT_XAI_BASE_URL).replace(/\/+$/, '');
  return {
    configured: true,
    apiKey,
    baseUrl,
    model: env.X_SEARCH_MODEL || env.XAI_GROK_MODEL || DEFAULT_XAI_CHAT_MODEL,
  };
}

function isConfigured(env = process.env) {
  return resolveXaiProvider(env).configured;
}

// Validate a YYYY-MM-DD date hint; xAI wants ISO 8601 dates for the
// from_date / to_date search bounds. Anything else is ignored.
function isoDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? value.trim() : null;
}

function buildSearchParameters(opts = {}) {
  const maxResults = Math.max(1, Math.min(Number(opts.maxResults) || 15, 30));
  const handles = Array.isArray(opts.handles)
    ? opts.handles.map((h) => String(h || '').replace(/^@/, '').trim()).filter(Boolean).slice(0, 10)
    : [];

  // X is always present; callers may add web/news. De-dupe + validate.
  const requested = Array.isArray(opts.sources) && opts.sources.length
    ? opts.sources.map((s) => String(s || '').toLowerCase().trim()).filter((s) => ALLOWED_SOURCES.has(s))
    : [];
  const kinds = Array.from(new Set(['x', ...requested]));
  const sources = kinds.map((type) => {
    const src = { type };
    if (type === 'x' && handles.length) src.x_handles = handles;
    return src;
  });

  const mode = opts.mode === 'auto' ? 'auto' : 'on';
  const params = {
    mode, // force live search regardless of the model's own judgement
    return_citations: true,
    max_search_results: maxResults,
    sources,
  };
  const from = isoDate(opts.fromDate);
  const to = isoDate(opts.toDate);
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  return params;
}

// True when the URL points at X/Twitter (host-aware, not a loose substring).
function isXHost(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }
  return host === 'x.com' || host.endsWith('.x.com')
    || host === 'twitter.com' || host.endsWith('.twitter.com');
}

function normaliseCitations(data) {
  // xAI returns citations as a top-level array of URL strings; be liberal
  // and also accept objects ({url,title}) and a per-message location.
  const raw = Array.isArray(data?.citations)
    ? data.citations
    : Array.isArray(data?.choices?.[0]?.message?.citations)
      ? data.choices[0].message.citations
      : [];
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    const url = typeof c === 'string' ? c : (c && typeof c.url === 'string' ? c.url : null);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const item = { url, source: isXHost(url) ? 'x' : 'web' };
    if (c && typeof c === 'object') {
      if (c.title) item.title = String(c.title).slice(0, 240);
      if (c.text || c.snippet) item.snippet = String(c.text || c.snippet).slice(0, 600);
    }
    out.push(item);
  }
  return out;
}

// Transient-only retry classifier (mirror of the github/brave policy).
function classifyXSearchError(err) {
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
  const disabled = String(process.env.X_SEARCH_RETRY_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true' || disabled === 'yes') return { maxRetries: 0 };
  const envRetries = Number.parseInt(process.env.X_SEARCH_MAX_RETRIES, 10);
  const envBase = Number.parseInt(process.env.X_SEARCH_RETRY_BASE_MS, 10);
  const maxRetries = Number.isFinite(envRetries) && envRetries >= 0 ? envRetries : 1;
  const baseDelayMs = Number.isFinite(envBase) && envBase > 0 ? envBase : 300;
  return { maxRetries: Math.max(0, Math.min(maxRetries, 4)), baseDelayMs };
}

async function search(query, opts = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  const env = opts.env || process.env;
  const provider = resolveXaiProvider(env);

  if (!q) {
    return { configured: provider.configured, query: '', model: provider.model, summary: '', results: [], citations: [], note: 'missing "query"' };
  }
  if (!provider.configured) {
    metrics.recordUnconfigured();
    return { configured: false, query: q, model: provider.model, summary: '', results: [], citations: [], note: UNCONFIGURED_NOTE };
  }

  const fetcher = opts.fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw Object.assign(new Error('x-search fetch unavailable'), { code: 'x_search_fetch_unavailable' });
  }

  const body = {
    model: provider.model,
    messages: [
      {
        role: 'system',
        content:
          'You are a real-time X (Twitter) search assistant. Use live search to find the most relevant and recent X posts for the user query. Summarise the key findings concisely and rely only on the retrieved posts; never invent posts or links.',
      },
      {
        role: 'user',
        content: `Search X (Twitter) for: ${q}\nReturn a concise summary of the most relevant recent posts.`,
      },
    ],
    search_parameters: buildSearchParameters(opts),
    temperature: 0,
    stream: false,
  };

  const postOnce = async () => {
    const res = await fetcher(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res || !res.ok) {
      // Query-free error so the raw user query never lands in logs/retries.
      throw new XSearchHttpError(res ? res.status : 0, `x-search http ${res ? res.status : 'no_response'}`);
    }
    return res.json();
  };

  const cfg = retryConfig();
  try {
    const data = cfg.maxRetries
      ? await withRetry(postOnce, {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.baseDelayMs,
        maxDelayMs: 3000,
        classifyError: classifyXSearchError,
        signal: opts.signal,
        ...(typeof opts.sleep === 'function' ? { sleep: opts.sleep } : {}),
      })
      : await postOnce();

    const summary = String(data?.choices?.[0]?.message?.content || '').trim();
    const citations = normaliseCitations(data);
    metrics.recordSearch({ resultCount: citations.length });
    return {
      configured: true,
      query: q,
      model: data?.model || provider.model,
      summary,
      results: citations,
      citations,
      usage: data?.usage || null,
    };
  } catch (err) {
    metrics.recordError({ code: classifyXSearchError(err).reason });
    throw err;
  }
}

module.exports = {
  search,
  isConfigured,
  resolveXaiProvider,
  buildSearchParameters,
  normaliseCitations,
  classifyXSearchError,
  retryConfig,
  XSearchHttpError,
  UNCONFIGURED_NOTE,
};
