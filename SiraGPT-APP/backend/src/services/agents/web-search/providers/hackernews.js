/**
 * hackernews — Hacker News via the Algolia search API. Free, no key, fast.
 *
 * Endpoint: https://hn.algolia.com/api/v1/search?query=…&tags=story&hitsPerPage=N
 *
 * Great for tech news, launches, "Show HN" projects and discussion. Stories
 * with an external `url` link out to it; Ask/Show HN without a url link to the
 * HN item page. Returns [] (not an error) when there are no hits.
 *
 * Response shape (trimmed):
 *   { hits: [{ objectID, title, url, points, num_comments, author,
 *              created_at, story_text }, …] }
 */

const fetch = require('node-fetch');

const ENDPOINT = 'https://hn.algolia.com/api/v1/search';
const ITEM_BASE = 'https://news.ycombinator.com/item?id=';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function search(query, { maxResults = 5, signal } = {}) {
  const hitsPerPage = Math.max(1, Math.min(Number(maxResults) || 5, 30));
  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: String(hitsPerPage),
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`hackernews http ${res.status}`);
  const body = await res.json();
  const hits = Array.isArray(body?.hits) ? body.hits : [];

  const out = [];
  for (const h of hits) {
    if (out.length >= hitsPerPage) break;
    const title = String(h?.title || '').trim();
    if (!title) continue;
    const id = h?.objectID;
    const url = typeof h?.url === 'string' && /^https?:\/\//.test(h.url)
      ? h.url
      : (id ? `${ITEM_BASE}${id}` : null);
    if (!url) continue;
    const bits = [];
    if (Number.isFinite(h?.points)) bits.push(`${h.points} puntos`);
    if (Number.isFinite(h?.num_comments)) bits.push(`${h.num_comments} comentarios`);
    const text = stripHtml(h?.story_text);
    const meta = bits.join(' · ');
    const snippet = [meta, text].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'hackernews',
    });
  }
  return out;
}

module.exports = {
  id: 'hackernews',
  name: 'Hacker News (Algolia)',
  priority: 14,
  enabled: true,
  search,
  _internal: { stripHtml },
};
