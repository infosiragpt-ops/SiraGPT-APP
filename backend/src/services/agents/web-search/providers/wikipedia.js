/**
 * wikipedia — OpenSearch + summary REST. Free, no key.
 *
 * 1. opensearch:    `https://{lang}.wikipedia.org/w/api.php?action=opensearch&search=…`
 *    Returns `[query, titles[], descriptions[], urls[]]` — fast, lightweight.
 * 2. (optional, future) page/summary REST for richer snippets.
 *
 * Excellent fallback for "what is / who is" style queries; for live
 * news / very fresh topics it's intentionally weak (intended).
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';

function resolveLang(locale) {
  if (typeof locale !== 'string') return 'en';
  const m = locale.match(/^([a-z]{2})(?:[-_][a-z]{2})?$/i);
  return m ? m[1].toLowerCase() : 'en';
}

async function search(query, { maxResults = 5, signal, locale } = {}) {
  const lang = resolveLang(locale);
  const params = new URLSearchParams({
    action: 'opensearch',
    format: 'json',
    search: query,
    limit: String(Math.max(1, Math.min(maxResults, 10))),
    namespace: '0',
  });
  const url = `https://${lang}.wikipedia.org/w/api.php?${params.toString()}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`wikipedia http ${res.status}`);
  const body = await res.json();
  // opensearch shape: [query, titles[], descriptions[], urls[]]
  if (!Array.isArray(body) || body.length < 4) return [];
  const titles = Array.isArray(body[1]) ? body[1] : [];
  const descs = Array.isArray(body[2]) ? body[2] : [];
  const urls = Array.isArray(body[3]) ? body[3] : [];
  const out = [];
  for (let i = 0; i < titles.length && out.length < maxResults; i++) {
    const u = urls[i];
    if (!u || typeof u !== 'string' || !/^https?:\/\//.test(u)) continue;
    const title = String(titles[i] || '').trim() || u;
    const snippet = String(descs[i] || '').trim() || `Artículo de Wikipedia: ${title}`;
    out.push({ title, url: u, snippet: snippet.slice(0, 600), source: 'wikipedia' });
  }
  return out;
}

module.exports = {
  id: 'wikipedia',
  name: 'Wikipedia OpenSearch',
  priority: 20,
  enabled: true,
  search,
};
