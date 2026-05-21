/**
 * arxiv — arXiv preprints (export.arxiv.org). Free, no key.
 * Authoritative for physics, math, CS, quant-bio, stats, q-finance.
 *
 * Endpoint: http://export.arxiv.org/api/query?search_query=all:…&max_results=N
 *
 * Response is **Atom XML** (not JSON). To avoid adding an XML parser
 * dependency we use a small regex-based extractor: the arXiv API
 * documents its schema and the output is consistently well-formed.
 *
 * Per-entry shape (trimmed):
 *   <entry>
 *     <id>http://arxiv.org/abs/2401.12345v1</id>
 *     <title>…</title>
 *     <summary>…abstract…</summary>
 *     <published>2024-01-23T…</published>
 *     <author><name>…</name></author> …
 *   </entry>
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';
const ENDPOINT = 'http://export.arxiv.org/api/query';

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function squashWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractAll(re, text) {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

function parseEntries(xml, maxResults) {
  const entries = extractAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g, xml).map((m) => m[1]);
  const out = [];
  for (const e of entries) {
    if (out.length >= maxResults) break;
    const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
    const titleRaw = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
    const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1] || '';
    const authors = extractAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g, e)
      .map((m) => squashWs(decodeXmlEntities(m[1])))
      .filter(Boolean);

    const url = squashWs(id).replace(/^http:/, 'https:');
    const title = squashWs(decodeXmlEntities(titleRaw));
    if (!title || !/^https?:\/\/arxiv\.org\//.test(url)) continue;

    const year = (published.match(/^(\d{4})/) || [])[1] || '';
    const auths = authors.slice(0, 4).join(', ');
    const meta = ['arXiv', year, auths].filter(Boolean).join(' · ');
    const abstract = squashWs(decodeXmlEntities(summary));
    const snippet = [meta, abstract].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'arxiv',
    });
  }
  return out;
}

async function search(query, { maxResults = 5, signal } = {}) {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    max_results: String(Math.max(1, Math.min(maxResults, 20))),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml' },
    signal,
  });
  if (!res.ok) throw new Error(`arxiv http ${res.status}`);
  const xml = await res.text();
  return parseEntries(xml, maxResults);
}

module.exports = {
  id: 'arxiv',
  name: 'arXiv preprints',
  priority: 7,
  enabled: true,
  search,
  _parseEntries: parseEntries,
};
