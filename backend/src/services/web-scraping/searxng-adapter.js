'use strict';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080';

function createSearXNGSearcher({ fetchImpl = globalThis.fetch } = {}) {
  const configured = Boolean(process.env.SEARXNG_URL);

  async function search(query, { categories = '', maxResults = 10, language = 'es' } = {}) {
    if (!configured) return { configured: false, results: [], error: 'SEARXNG_URL not set' };
    const params = new URLSearchParams({ q: query, format: 'json', language, safesearch: '1', pageno: '1' });
    if (categories) params.set('categories', categories);
    const res = await fetchImpl(`${SEARXNG_URL.replace(/\/$/, '')}/search?${params.toString()}`);
    if (!res.ok) return { configured: true, results: [], error: `SearXNG returned ${res.status}` };
    const data = await res.json();
    const results = (data.results || []).slice(0, maxResults).map(r => ({ title: r.title, snippet: r.content || r.snippet || '', url: r.url, engine: r.engine || 'unknown' }));
    return { configured: true, results };
  }

  return { configured, search };
}

module.exports = { createSearXNGSearcher };
