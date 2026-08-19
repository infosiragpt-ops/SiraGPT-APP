/**
 * github — GitHub repository search. Free; key-less works (lower rate limit),
 * an optional SIRAGPT_GITHUB_TOKEN / GITHUB_TOKEN lifts it. Great breadth for
 * technical/library/project queries in the aggregating `searchMany` path.
 *
 * Endpoint: https://api.github.com/search/repositories
 *           ?q=…&sort=stars&order=desc&per_page=N
 *
 * Response shape (trimmed):
 *   { items: [{ full_name, html_url, description, stargazers_count,
 *               language, topics }, …] }
 *
 * Returns [] (not an error) on an empty result set so the adapter falls
 * through cleanly for non-technical prompts.
 */

const fetch = require('node-fetch');

const ENDPOINT = 'https://api.github.com/search/repositories';
const USER_AGENT = 'SiraGPT-WebSearch/1.0 (+https://siragpt.com)';

async function search(query, { maxResults = 5, signal, env = process.env } = {}) {
  const perPage = Math.max(1, Math.min(Number(maxResults) || 5, 30));
  const params = new URLSearchParams({
    q: query,
    sort: 'stars',
    order: 'desc',
    per_page: String(perPage),
  });
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = env.SIRAGPT_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { method: 'GET', headers, signal });
  if (!res.ok) throw new Error(`github http ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.items) ? body.items : [];

  const out = [];
  for (const it of items) {
    if (out.length >= perPage) break;
    const title = String(it?.full_name || '').trim();
    const url = typeof it?.html_url === 'string' ? it.html_url : null;
    if (!title || !url) continue;
    const bits = [];
    if (Number.isFinite(it?.stargazers_count)) bits.push(`★ ${it.stargazers_count}`);
    if (it?.language) bits.push(String(it.language));
    const meta = bits.join(' · ');
    const desc = String(it?.description || '').trim();
    const snippet = [meta, desc].filter(Boolean).join(' — ');
    out.push({
      title,
      url,
      snippet: snippet.slice(0, 600),
      source: 'github',
    });
  }
  return out;
}

module.exports = {
  id: 'github',
  name: 'GitHub repositories',
  priority: 16,
  enabled: true,
  search,
};
