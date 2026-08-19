/**
 * openalex — OpenAlex (api.openalex.org). Free, no key.
 * Open replacement for Microsoft Academic Graph; 250M+ scholarly works
 * with rich metadata + citation context. Multidisciplinary fallback
 * for scientific queries that don't match Crossref/PubMed.
 *
 * Endpoint: https://api.openalex.org/works?search=…&per_page=N&mailto=…
 *
 * Response shape (trimmed):
 *   { results: [{
 *       id, doi, title,
 *       abstract_inverted_index: { "word": [positions…], … },
 *       authorships: [{ author: { display_name } }],
 *       publication_year,
 *       primary_location: { source: { display_name } },
 *       open_access: { oa_url, is_oa },
 *     }, …] }
 *
 * OpenAlex returns abstracts as an inverted index (word → positions)
 * for licensing reasons. We rebuild it into a short snippet.
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (mailto:hello@siragpt.com)';
const ENDPOINT = 'https://api.openalex.org/works';
const POLITE_MAILTO = 'hello@siragpt.com';

function rebuildAbstract(inverted, maxWords = 80) {
  if (!inverted || typeof inverted !== 'object') return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(inverted)) {
    if (!Array.isArray(idxs)) continue;
    for (const i of idxs) positions.push([i, word]);
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.slice(0, maxWords).map((p) => p[1]).join(' ');
}

async function search(query, { maxResults = 5, signal } = {}) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.max(1, Math.min(maxResults, 25))),
    mailto: POLITE_MAILTO,
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`openalex http ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.results) ? body.results : [];

  const out = [];
  for (const it of items) {
    if (out.length >= maxResults) break;
    const title = String(it?.title || '').trim();
    if (!title) continue;
    const doi = typeof it?.doi === 'string' ? it.doi.replace(/^https?:\/\/doi\.org\//, '') : null;
    // Prefer DOI link (most stable), then OA url, then OpenAlex id.
    const url = doi
      ? `https://doi.org/${doi}`
      : (typeof it?.open_access?.oa_url === 'string' ? it.open_access.oa_url : (typeof it?.id === 'string' ? it.id : null));
    if (!url) continue;
    const journal = String(it?.primary_location?.source?.display_name || '').trim();
    const year = it?.publication_year ? String(it.publication_year) : '';
    const authors = Array.isArray(it?.authorships)
      ? it.authorships.slice(0, 4).map((a) => a?.author?.display_name).filter(Boolean).join(', ')
      : '';
    const abstract = rebuildAbstract(it?.abstract_inverted_index);
    const meta = [journal, year, authors].filter(Boolean).join(' · ');
    const snippet = [meta, abstract].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'openalex',
    });
  }
  return out;
}

module.exports = {
  id: 'openalex',
  name: 'OpenAlex scholarly works',
  priority: 6,
  enabled: true,
  search,
  _rebuildAbstract: rebuildAbstract,
};
