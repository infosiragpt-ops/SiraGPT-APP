'use strict';

function needsFreshWebContext(prompt = '') {
  return /\b(actual|hoy|últim[ao]s?|latest|current|noticias|paper reciente|precio|202[5-9]|ahora)\b/i.test(String(prompt || ''));
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

async function searchFreshContext(query, opts = {}) {
  const errors = [];
  try {
    const primary = await tavilySearch(query, opts);
    if (primary.results?.length || primary.configured) return primary;
  } catch (err) { errors.push({ provider: 'tavily', message: err.message }); }
  try {
    const fallback = await exaSearch(query, opts);
    return { ...fallback, errors };
  } catch (err) { errors.push({ provider: 'exa', message: err.message }); }
  return { provider: 'none', configured: false, results: [], errors };
}

module.exports = { exaSearch, needsFreshWebContext, searchFreshContext, tavilySearch };
