/**
 * crossref — official DOI registry (api.crossref.org). Free, no key.
 * Highest priority among scientific providers because Crossref is the
 * authoritative source of truth for any work that has a DOI.
 *
 * Endpoint: https://api.crossref.org/works?query=…&rows=N&mailto=…
 *
 * Response shape (trimmed):
 *   { message: { items: [{
 *       DOI, title:[…], author:[{given,family}], abstract,
 *       'container-title':[…], 'published-print':{date-parts:[[Y,M,D]]},
 *       URL,
 *     }, …] } }
 *
 * The "mailto" query param opts us into the polite pool (better
 * rate-limits and SLAs) — Crossref documents this in their REST API
 * guide. We never send user info, only our own contact address.
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (mailto:hello@siragpt.com)';
const ENDPOINT = 'https://api.crossref.org/works';
const POLITE_MAILTO = 'hello@siragpt.com';

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickYear(item) {
  const parts = item?.['published-print']?.['date-parts']
    || item?.['published-online']?.['date-parts']
    || item?.issued?.['date-parts'];
  const y = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
  return y ? String(y) : '';
}

function pickAuthors(item) {
  const list = Array.isArray(item?.author) ? item.author : [];
  return list
    .slice(0, 4)
    .map((a) => [a?.given, a?.family].filter(Boolean).join(' ').trim())
    .filter(Boolean)
    .join(', ');
}

async function search(query, { maxResults = 5, signal } = {}) {
  const params = new URLSearchParams({
    query,
    rows: String(Math.max(1, Math.min(maxResults, 20))),
    mailto: POLITE_MAILTO,
    // Crossref scores results better when we ask for relevance order.
    sort: 'relevance',
    order: 'desc',
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`crossref http ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.message?.items) ? body.message.items : [];

  const out = [];
  for (const it of items) {
    if (out.length >= maxResults) break;
    const title = stripHtml(Array.isArray(it?.title) ? it.title[0] : it?.title);
    if (!title) continue;
    const doi = it?.DOI;
    const url = doi ? `https://doi.org/${doi}` : (typeof it?.URL === 'string' ? it.URL : null);
    if (!url) continue;
    const journal = stripHtml(Array.isArray(it?.['container-title']) ? it['container-title'][0] : '');
    const year = pickYear(it);
    const authors = pickAuthors(it);
    const abstract = stripHtml(it?.abstract);
    const meta = [journal, year, authors].filter(Boolean).join(' · ');
    const snippet = [meta, abstract].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'crossref',
    });
  }
  return out;
}

module.exports = {
  id: 'crossref',
  name: 'Crossref DOI registry',
  priority: 3,
  enabled: true,
  search,
};
