'use strict';

/**
 * Perplexity Search API provider (`POST https://api.perplexity.ai/search`).
 *
 * Built for agentic single-call lookups (~160 ms p50 per Perplexity), it is
 * the first rung of the "Búsqueda rápida" ladder whenever PERPLEXITY_API_KEY
 * (or the PPLX_API_KEY alias) is configured — either in the .env or through
 * Admin → Conexiones (admin-connections-bridge writes it into process.env).
 * The key is read lazily per call so a runtime swap needs no restart.
 */

const ENDPOINT = 'https://api.perplexity.ai/search';

function perplexityKey() {
  const raw = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '';
  const key = String(raw).trim();
  return key.length > 0 ? key : null;
}

// Agent tools speak Brave-style windows (pd/pw/pm/py) and plain words.
function recencyFilter(freshness) {
  const f = String(freshness || '').trim().toLowerCase();
  if (!f) return null;
  if (f === 'pd' || f === 'day' || f === 'd') return 'day';
  if (f === 'pw' || f === 'week' || f === 'w') return 'week';
  if (f === 'pm' || f === 'month' || f === 'm') return 'month';
  if (f === 'py' || f === 'year' || f === 'y') return 'year';
  return null;
}

function countryFromLocale(locale) {
  const m = /^[a-z]{2}[-_]([a-z]{2})$/i.exec(String(locale || '').trim());
  return m ? m[1].toUpperCase() : null;
}

function buildBody(query, { maxResults = 8, freshness, locale, domains, excludeDomains } = {}) {
  const body = {
    query,
    max_results: Math.max(1, Math.min(Number(maxResults) || 8, 20)),
    // Snippets only: the agent calls read_url for full pages, so a small
    // per-page budget keeps the call on the fast path.
    max_tokens_per_page: 512,
  };
  const recency = recencyFilter(freshness);
  if (recency) body.search_recency_filter = recency;
  const country = countryFromLocale(locale);
  if (country) body.country = country;
  const filter = [
    ...(Array.isArray(domains) ? domains : []),
    ...(Array.isArray(excludeDomains) ? excludeDomains.map((d) => `-${d}`) : []),
  ].filter(Boolean).slice(0, 20);
  if (filter.length) body.search_domain_filter = filter;
  return body;
}

async function search(query, opts = {}) {
  const key = perplexityKey();
  if (!key) return [];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(buildBody(query, opts)),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`perplexity http ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.results) ? body.results : [];
  return list
    .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
    .map((r) => ({
      title: String(r.title || r.url).slice(0, 240),
      url: r.url,
      snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      ...(r.date || r.last_updated ? { date: String(r.date || r.last_updated).slice(0, 40) } : {}),
      source: 'perplexity',
    }));
}

module.exports = {
  id: 'perplexity',
  name: 'Perplexity Search',
  get enabled() { return perplexityKey() !== null; },
  search,
  _internal: { perplexityKey, recencyFilter, countryFromLocale, buildBody, ENDPOINT },
};
