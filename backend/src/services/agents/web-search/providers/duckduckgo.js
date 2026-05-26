/**
 * duckduckgo — Instant Answers JSON API. Free, no API key.
 *
 * Endpoint: https://api.duckduckgo.com/?q=…&format=json&no_html=1&no_redirect=1
 *
 * The IA API is intentionally sparse (it powers DDG's zero-click box),
 * so for a generic query you typically get an `AbstractText` + a list
 * of `RelatedTopics`. Each topic is `{ Text, FirstURL, Icon }`. We
 * normalise both shapes into `{ title, url, snippet, source }`.
 *
 * Some queries return nothing — that's not an error, just an empty
 * result set. The adapter treats `[]` as "try next provider", so we
 * intentionally surface `[]` rather than throwing.
 */

const fetch = require('node-fetch');

const ENDPOINT = 'https://api.duckduckgo.com/';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';

async function search(query, { maxResults = 5, signal, locale } = {}) {
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
  const url = `${ENDPOINT}?${params.toString()}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`duckduckgo http ${res.status}`);
  // DDG returns text/javascript despite `format=json`; force JSON parse.
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch (err) {
    throw new Error('duckduckgo invalid json');
  }

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

  // De-duplicate by URL while preserving order.
  const seen = new Set();
  const unique = [];
  for (const r of out) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    unique.push(r);
  }
  return unique.slice(0, maxResults);
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

module.exports = {
  id: 'duckduckgo',
  name: 'DuckDuckGo Instant Answers',
  priority: 10,
  enabled: true,
  search,
};
