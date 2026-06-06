/**
 * duckduckgo — Instant Answers + HTML search. Free, no API key.
 *
 * Endpoint: https://api.duckduckgo.com/?q=…&format=json&no_html=1&no_redirect=1
 *
 * The IA API is intentionally sparse (it powers DDG's zero-click box),
 * so for a generic query you often get no `AbstractText`. When that
 * happens, fall back to DDG's lightweight HTML endpoint and parse the
 * organic result blocks. This keeps SiraGPT key-less while making DDG
 * useful for normal web-search prompts, not only encyclopedia-style
 * instant answers.
 *
 * Some queries return nothing — that's not an error, just an empty
 * result set. The adapter treats `[]` as "try next provider", so we
 * intentionally surface `[]` rather than throwing.
 */

const fetch = require('node-fetch');

const INSTANT_ANSWER_ENDPOINT = 'https://api.duckduckgo.com/';
const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';

async function search(query, { maxResults = 5, signal, locale } = {}) {
  const limit = Math.max(1, Math.min(Number(maxResults) || 5, 15));
  const out = await searchInstantAnswer(query, { maxResults: limit, signal, locale });
  if (out.length >= limit) return uniqueResults(out, limit);

  const htmlResults = await searchHtml(query, {
    maxResults: limit - out.length,
    signal,
    locale,
  });
  return uniqueResults([...out, ...htmlResults], limit);
}

async function searchInstantAnswer(query, { maxResults = 5, signal, locale } = {}) {
  const params = buildParams(query, locale);
  const url = `${INSTANT_ANSWER_ENDPOINT}?${params.toString()}`;
  const raw = await fetchText(url, { signal, accept: 'application/json' });
  let body;
  try { body = JSON.parse(raw); } catch (err) {
    throw new Error('duckduckgo invalid json');
  }
  return parseInstantAnswer(body, maxResults);
}

async function searchHtml(query, { maxResults = 5, signal, locale } = {}) {
  const params = buildParams(query, locale);
  const url = `${HTML_ENDPOINT}?${params.toString()}`;
  const html = await fetchText(url, { signal, accept: 'text/html' });
  return parseHtmlResults(html, maxResults);
}

async function fetchText(url, { signal, accept }) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: accept || '*/*' },
    signal,
  });
  if (!res.ok) throw new Error(`duckduckgo http ${res.status}`);
  return res.text();
}

function buildParams(query, locale) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    no_redirect: '1',
    t: 'siragpt',
  });
  if (locale && /^[a-z]{2}-[a-z]{2}$/i.test(locale)) {
    params.set('kl', locale.toLowerCase());
  }
  return params;
}

function parseInstantAnswer(body, maxResults = 5) {
  const out = [];
  if (body.AbstractText && body.AbstractURL) {
    out.push({
      title: body.Heading || body.AbstractSource || body.AbstractURL,
      url: body.AbstractURL,
      snippet: String(body.AbstractText).slice(0, 600),
      source: 'duckduckgo',
    });
  }

  const topics = Array.isArray(body.RelatedTopics) ? body.RelatedTopics : [];
  for (const t of topics) {
    if (out.length >= maxResults) break;
    // Some entries are sub-categories: { Name, Topics: [...] }.
    if (t && Array.isArray(t.Topics)) {
      for (const sub of t.Topics) {
        if (out.length >= maxResults) break;
        const item = normaliseTopic(sub);
        if (item) out.push(item);
      }
      continue;
    }
    const item = normaliseTopic(t);
    if (item) out.push(item);
  }

  return uniqueResults(out, maxResults);
}

function normaliseTopic(t) {
  if (!t || typeof t !== 'object') return null;
  const url = t.FirstURL || t.URL;
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const text = String(t.Text || '').trim();
  if (!text) return null;
  // DDG topic text is usually "<title> - <snippet>". Split on the first
  // " - " to recover a usable title/snippet pair without losing dashes
  // that appear later in the description.
  let title = text;
  let snippet = text;
  const dashIdx = text.indexOf(' - ');
  if (dashIdx > 0 && dashIdx < 160) {
    title = text.slice(0, dashIdx).trim();
    snippet = text.slice(dashIdx + 3).trim();
  }
  return { title, url, snippet: snippet.slice(0, 600), source: 'duckduckgo' };
}

function parseHtmlResults(html, maxResults = 5) {
  const out = [];
  const blocks = String(html || '').split(/<div[^>]+class=(?:"|')[^"']*\bresult\b[^"']*(?:"|')[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (out.length >= maxResults) break;
    const linkMatch = block.match(/<a[^>]+class=(?:"|')[^"']*\bresult__a\b[^"']*(?:"|')[^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]+href=(?:"|')([^"']+)(?:"|')[^>]*class=(?:"|')[^"']*\bresult__a\b[^"']*(?:"|')[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = unwrapDuckDuckGoUrl(decodeHtml(linkMatch[1]));
    if (!url) continue;
    const title = cleanHtmlText(linkMatch[2]);
    if (!title) continue;
    const snippetMatch = block.match(/<a[^>]+class=(?:"|')[^"']*\bresult__snippet\b[^"']*(?:"|')[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class=(?:"|')[^"']*\bresult__snippet\b[^"']*(?:"|')[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? cleanHtmlText(snippetMatch[1]) : '';
    out.push({
      title: title.slice(0, 240),
      url,
      snippet: snippet.slice(0, 600),
      source: 'duckduckgo',
    });
  }
  return uniqueResults(out, maxResults);
}

function unwrapDuckDuckGoUrl(value) {
  if (!value || typeof value !== 'string') return null;
  let url = value.trim();
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('/')) url = `https://duckduckgo.com${url}`;
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return safeHttpUrl(decodeURIComponent(uddg));
    return safeHttpUrl(parsed.toString());
  } catch (_) {
    return null;
  }
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function cleanHtmlText(value) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function uniqueResults(results, maxResults = 5) {
  const seen = new Set();
  const unique = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r?.url || seen.has(r.url)) continue;
    seen.add(r.url);
    unique.push(r);
    if (unique.length >= maxResults) break;
  }
  return unique;
}

module.exports = {
  id: 'duckduckgo',
  name: 'DuckDuckGo Web Search',
  priority: 10,
  enabled: true,
  search,
  _internal: {
    cleanHtmlText,
    parseHtmlResults,
    parseInstantAnswer,
    unwrapDuckDuckGoUrl,
  },
};
