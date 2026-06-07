/**
 * stackexchange — Stack Exchange / Stack Overflow Q&A. Free, no key.
 *
 * Endpoint: https://api.stackexchange.com/2.3/search/advanced
 *           ?order=desc&sort=relevance&q=…&site=stackoverflow&pagesize=N
 *
 * Key-less quota is ~300 req/day/IP (an `key`/`access_token` lifts it, but we
 * stay key-less by design). Responses are gzip-encoded — node-fetch handles
 * decompression transparently. Excellent for technical/programming queries;
 * returns [] (not an error) for non-technical prompts so the adapter falls
 * through cleanly.
 *
 * Response shape (trimmed):
 *   { items: [{ title, link, tags:[…], score, answer_count, is_answered,
 *               creation_date }, …] }
 */

const fetch = require('node-fetch');

const ENDPOINT = 'https://api.stackexchange.com/2.3/search/advanced';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com; contact: hello@siragpt.com)';

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

async function search(query, { maxResults = 5, signal, site = 'stackoverflow' } = {}) {
  const pagesize = Math.max(1, Math.min(Number(maxResults) || 5, 30));
  const params = new URLSearchParams({
    order: 'desc',
    sort: 'relevance',
    q: query,
    site,
    pagesize: String(pagesize),
  });
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`stackexchange http ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.items) ? body.items : [];

  const out = [];
  for (const it of items) {
    if (out.length >= pagesize) break;
    const title = decodeHtml(it?.title).trim();
    const url = typeof it?.link === 'string' ? it.link : null;
    if (!title || !url) continue;
    const tags = Array.isArray(it?.tags) ? it.tags.slice(0, 6).join(', ') : '';
    const bits = [];
    if (it?.is_answered) bits.push('respondida');
    if (Number.isFinite(it?.answer_count)) bits.push(`${it.answer_count} respuestas`);
    if (Number.isFinite(it?.score)) bits.push(`score ${it.score}`);
    if (tags) bits.push(`tags: ${tags}`);
    out.push({
      title,
      url,
      snippet: bits.join(' · ').slice(0, 600),
      source: 'stackexchange',
    });
  }
  return out;
}

module.exports = {
  id: 'stackexchange',
  name: 'Stack Exchange Q&A',
  priority: 12,
  enabled: true,
  search,
  _internal: { decodeHtml },
};
