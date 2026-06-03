'use strict';

// JS regex `\b` (word boundary) is ASCII-only — `\bú`, `\bñ`,
// `\belección` silently fail to match because the boundary check
// treats accented letters as non-word characters. Replace `\b` with
// Unicode property classes (`\p{L}\p{N}`) inside lookahead /
// lookbehind so accented Spanish keywords ("últimos", "elección",
// "recientemente") trigger as expected. Requires the `u` flag.
const FRESH_WEB_CONTEXT_RE = /(?<![\p{L}\p{N}])(?:actual(?:es|mente)?|hoy|últim[ao]s?|latest|current|noticias?|paper\s+reciente|precio|202[5-9]|ahora|news|weather|clima|sismo|terremoto|elecci[oó]n|recien(?:te|tes|temente)|cotizaci[oó]n)(?![\p{L}\p{N}])/iu;

function needsFreshWebContext(prompt = '') {
  return FRESH_WEB_CONTEXT_RE.test(String(prompt || ''));
}

async function tavilySearch(query, { env = process.env, fetchImpl = globalThis.fetch, maxResults = 5 } = {}) {
  if (!env.TAVILY_API_KEY) return { provider: 'tavily', configured: false, results: [] };
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: maxResults, search_depth: 'advanced' }),
  });
  if (!res.ok) throw Object.assign(new Error(`Tavily search failed: ${res.status}`), { status: res.status });
  const body = await res.json();
  return { provider: 'tavily', configured: true, results: body.results || [] };
}

async function exaSearch(query, { env = process.env, fetchImpl = globalThis.fetch, maxResults = 5 } = {}) {
  if (!env.EXA_API_KEY) return { provider: 'exa', configured: false, results: [] };
  const res = await fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
    body: JSON.stringify({ query, numResults: maxResults, type: 'neural' }),
  });
  if (!res.ok) throw Object.assign(new Error(`Exa search failed: ${res.status}`), { status: res.status });
  const body = await res.json();
  return { provider: 'exa', configured: true, results: body.results || [] };
}

async function firecrawlSearch(query, { env = process.env, fetchImpl = globalThis.fetch, maxResults = 5 } = {}) {
  if (!env.FIRECRAWL_API_KEY) return { provider: 'firecrawl', configured: false, results: [] };
  const baseUrl = env.FIRECRAWL_HOST || 'https://api.firecrawl.dev';
  const res = await fetchImpl(`${baseUrl}/v1/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ query, limit: maxResults }),
  });
  if (!res.ok) throw Object.assign(new Error(`Firecrawl search failed: ${res.status}`), { status: res.status });
  const body = await res.json();
  const results = (body.data || body.results || []).map(r => ({
    title: r.title || r.metadata?.title || '',
    url: r.url || r.metadata?.sourceURL || '',
    content: r.content || r.markdown || r.text || '',
  }));
  return { provider: 'firecrawl', configured: true, results };
}

async function searxngSearch(query, { env = process.env, fetchImpl = globalThis.fetch, maxResults = 5 } = {}) {
  const url = env.SEARXNG_URL;
  if (!url) return { provider: 'searxng', configured: false, results: [] };
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/search`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ q: query, format: 'json', categories: 'general,science', pageno: '1' }).toString(),
    redirect: 'manual',
  }).then(r => {
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general,science' });
    return fetchImpl(`${url.replace(/\/$/, '')}/search?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
  }).catch(() => fetchImpl(`${url.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, {
    headers: { Accept: 'application/json' },
  }));
  if (!res.ok) throw Object.assign(new Error(`SearXNG search failed: ${res.status}`), { status: res.status });
  const body = await res.json();
  return {
    provider: 'searxng',
    configured: true,
    results: (body.results || []).slice(0, maxResults).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || r.snippet || '',
    })),
  };
}

// Free, key-less fallback (DuckDuckGo / Wikipedia / scientific tier). This is
// what makes "fresh web context" work for everyone even when no paid search
// keys are configured — without it, a deployment with no TAVILY/EXA/FIRECRAWL
// keys would silently never inject web results and the model would answer
// time-sensitive questions ("¿qué día es hoy?", "precio actual…") from stale
// training data.
async function freeTierSearch(query, { maxResults = 5, locale, freeSearch } = {}) {
  // `freeSearch` is injectable so unit tests stay hermetic (no real network);
  // production lazy-requires the agent web-search adapter so this module stays
  // loadable in contexts where that adapter isn't present.
  // eslint-disable-next-line global-require
  const freeAdapter = freeSearch || require('../services/agents/web-search');
  const out = await freeAdapter.search(query, { maxResults, locale });
  const results = (out?.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.snippet || r.content || '',
  }));
  return { provider: out?.provider ? `free:${out.provider}` : 'free', configured: true, results };
}

async function searchFreshContext(query, opts = {}) {
  const errors = [];

  try {
    const primary = await tavilySearch(query, opts);
    if (primary.results?.length) return primary;
  } catch (err) { errors.push({ provider: 'tavily', message: err.message }); }

  try {
    const exa = await exaSearch(query, opts);
    if (exa.results?.length) return { ...exa, errors: exa.errors || errors };
  } catch (err) { errors.push({ provider: 'exa', message: err.message }); }

  try {
    const firecrawl = await firecrawlSearch(query, opts);
    if (firecrawl.results?.length) return { ...firecrawl, errors };
  } catch (err) { errors.push({ provider: 'firecrawl', message: err.message }); }

  try {
    const searxng = await searxngSearch(query, opts);
    if (searxng.results?.length) return { ...searxng, errors };
  } catch (err) { errors.push({ provider: 'searxng', message: err.message }); }

  // No paid provider returned anything (or none configured) — always try the
  // free, key-less tier before giving up so web search works out of the box.
  // `disableFreeTier` lets hermetic tests opt out entirely.
  if (opts.disableFreeTier !== true) {
    try {
      const free = await freeTierSearch(query, {
        maxResults: opts.limit || 5,
        locale: opts.locale,
        freeSearch: opts.freeSearch,
      });
      if (free.results?.length) return { ...free, errors };
    } catch (err) { errors.push({ provider: 'free', message: err.message }); }
  }

  return { provider: 'none', configured: false, results: [], errors };
}

function listWebSearchProviders(env = process.env) {
  return {
    tavily: Boolean(env.TAVILY_API_KEY),
    exa: Boolean(env.EXA_API_KEY),
    firecrawl: Boolean(env.FIRECRAWL_API_KEY),
    searxng: Boolean(env.SEARXNG_URL),
  };
}

module.exports = { exaSearch, firecrawlSearch, listWebSearchProviders, needsFreshWebContext, searchFreshContext, searxngSearch, tavilySearch };
