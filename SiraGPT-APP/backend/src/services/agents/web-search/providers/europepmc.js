/**
 * europepmc — Europe PMC REST search. Free, no key. ~40M biomedical/life-
 * science abstracts (PubMed + PMC + Agricola + preprints), a strong scientific
 * complement to Crossref/PubMed/OpenAlex.
 *
 * Endpoint: https://www.ebi.ac.uk/europepmc/webservices/rest/search
 *           ?query=…&format=json&resultType=lite&pageSize=N
 *
 * Response shape (trimmed):
 *   { resultList: { result: [{
 *       id, source, pmid, doi, title, authorString,
 *       journalTitle, pubYear, abstractText,
 *     }, …] } }
 */

const fetch = require('node-fetch');

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (mailto:hello@siragpt.com)';

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function search(query, { maxResults = 5, signal } = {}) {
  const pageSize = Math.max(1, Math.min(Number(maxResults) || 5, 50));
  const params = new URLSearchParams({
    query,
    format: 'json',
    resultType: 'lite',
    pageSize: String(pageSize),
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`europepmc http ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.resultList?.result) ? body.resultList.result : [];

  const out = [];
  for (const it of items) {
    if (out.length >= pageSize) break;
    const title = stripHtml(it?.title);
    if (!title) continue;
    const doi = typeof it?.doi === 'string' ? it.doi : null;
    const url = doi
      ? `https://doi.org/${doi}`
      : (it?.source && it?.id ? `https://europepmc.org/abstract/${it.source}/${it.id}` : null);
    if (!url) continue;
    const meta = [it?.journalTitle, it?.pubYear, it?.authorString].filter(Boolean).join(' · ');
    const snippet = [meta, stripHtml(it?.abstractText)].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'europepmc',
    });
  }
  return out;
}

module.exports = {
  id: 'europepmc',
  name: 'Europe PMC',
  priority: 8,
  enabled: true,
  search,
};
