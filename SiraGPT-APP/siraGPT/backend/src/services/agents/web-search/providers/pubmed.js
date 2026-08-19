/**
 * pubmed — NCBI E-utilities (eutils.ncbi.nlm.nih.gov). Free, no key.
 * Gold standard for biomedical literature.
 *
 * Two-call protocol (esearch → esummary):
 *   1) esearch.fcgi?db=pubmed&term=…&retmode=json&retmax=N
 *      → { esearchresult: { idlist: [pmid, …] } }
 *   2) esummary.fcgi?db=pubmed&id=PMID1,PMID2&retmode=json
 *      → { result: { PMIDx: { title, source, pubdate, authors:[{name}], elocationid } } }
 *
 * The provider only "wins" when the query matches biomedical
 * literature — for non-biomedical queries esearch returns 0 ids and
 * the adapter falls through.
 *
 * NCBI asks identifiers in the User-Agent and an optional `email`
 * param for the polite pool; we set both.
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (mailto:hello@siragpt.com)';
const POLITE_EMAIL = 'hello@siragpt.com';
const TOOL_NAME = 'siragpt';
const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

async function search(query, { maxResults = 5, signal } = {}) {
  const ids = await esearch(query, { maxResults, signal });
  if (ids.length === 0) return [];
  const summaries = await esummary(ids, { signal });
  const out = [];
  for (const pmid of ids) {
    if (out.length >= maxResults) break;
    const s = summaries[pmid];
    if (!s) continue;
    const title = String(s.title || '').trim();
    if (!title) continue;
    const journal = String(s.source || s.fulljournalname || '').trim();
    const year = String(s.pubdate || '').slice(0, 4);
    const authors = Array.isArray(s.authors)
      ? s.authors.slice(0, 4).map((a) => a?.name).filter(Boolean).join(', ')
      : '';
    const doiObj = Array.isArray(s.articleids) ? s.articleids.find((x) => x?.idtype === 'doi') : null;
    const doi = doiObj?.value;
    const meta = [journal, year, authors].filter(Boolean).join(' · ');
    const snippet = doi ? `${meta} — DOI ${doi}`.trim() : meta;
    out.push({
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      snippet: snippet.slice(0, 600),
      source: 'pubmed',
    });
  }
  return out;
}

async function esearch(query, { maxResults, signal }) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmode: 'json',
    retmax: String(Math.max(1, Math.min(maxResults, 20))),
    sort: 'relevance',
    tool: TOOL_NAME,
    email: POLITE_EMAIL,
  });
  const res = await fetch(`${ESEARCH}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`pubmed esearch http ${res.status}`);
  const body = await res.json();
  const ids = body?.esearchresult?.idlist;
  return Array.isArray(ids) ? ids : [];
}

async function esummary(ids, { signal }) {
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json',
    tool: TOOL_NAME,
    email: POLITE_EMAIL,
  });
  const res = await fetch(`${ESUMMARY}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`pubmed esummary http ${res.status}`);
  const body = await res.json();
  const result = body?.result || {};
  // result.uids is metadata; the actual records are keyed by PMID.
  return result;
}

module.exports = {
  id: 'pubmed',
  name: 'PubMed (NCBI)',
  priority: 4,
  enabled: true,
  search,
};
