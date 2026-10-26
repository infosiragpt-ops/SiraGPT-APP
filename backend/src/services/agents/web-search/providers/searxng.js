/**
 * searxng — public SearXNG instance. JSON format is gated on many public
 * instances, so we default to an instance that exposes it
 * (`SEARXNG_BASE_URL` overrides the default). If the instance returns
 * 403/404, the adapter just falls through to the next provider.
 *
 * Why useful: SearXNG aggregates several engines (Google, Bing, Brave,
 * Qwant, …) without an API key on our side, so when DDG goes silent
 * this one usually still has fresh news / general web results.
 */

const fetch = require('node-fetch');

const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';
const DEFAULT_BASE = process.env.SEARXNG_BASE_URL || 'https://search.inetol.net';

async function search(query, { maxResults = 5, signal, locale } = {}) {
  const base = (process.env.SEARXNG_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    safesearch: '1',
  });
  if (locale && /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(locale)) {
    params.set('language', locale.toLowerCase().replace('_', '-'));
  }

  const res = await fetch(`${base}/search?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`searxng http ${res.status}`);
  let body = null;
  if (typeof res.text === 'function') {
    const raw = await res.text();
    try {
      body = JSON.parse(raw);
    } catch (_) {
      return parseHtmlResults(raw, maxResults);
    }
  } else {
    body = await res.json();
  }
  const items = Array.isArray(body?.results) ? body.results : [];
  const out = [];
  for (const it of items) {
    if (out.length >= maxResults) break;
    const url = it?.url;
    if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
    const title = String(it?.title || url).trim();
    const snippet = String(it?.content || it?.pretty_url || '').trim();
    out.push({ title, url, snippet: snippet.slice(0, 600), source: 'searxng' });
  }
  return out;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHtmlResults(html, maxResults = 5) {
  const out = [];
  const blockRe = /<article\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = blockRe.exec(String(html || ''))) !== null && out.length < maxResults) {
    const block = m[1];
    const linkMatch = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      || /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\burl_header\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = linkMatch[1].trim();
    const title = stripTags(linkMatch[2]) || url;
    const contentMatch = /<p\b[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = contentMatch ? stripTags(contentMatch[1]).slice(0, 600) : '';
    out.push({ title, url, snippet, source: 'searxng' });
  }
  return out;
}

module.exports = {
  id: 'searxng',
  name: 'SearXNG (public instance)',
  priority: 30,
  enabled: true,
  search,
  _internal: { parseHtmlResults },
};
