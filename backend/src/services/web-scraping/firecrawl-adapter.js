'use strict';

function createFirecrawlScraper({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.FIRECRAWL_API_KEY;
  const host = env.FIRECRAWL_HOST || 'https://api.firecrawl.dev';
  const configured = Boolean(apiKey);

  async function scrape(url, opts = {}) {
    if (!configured) return { configured: false, results: null, error: 'FIRECRAWL_API_KEY not set' };
    const res = await fetchImpl(`${host}/v1/scrape`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: opts.formats || ['markdown'], onlyMainContent: opts.onlyMainContent !== false, waitFor: opts.waitFor || 0 }),
    });
    if (!res.ok) throw Object.assign(new Error(`Firecrawl scrape failed: ${res.status}`), { status: res.status });
    const data = await res.json();
    return { configured: true, results: data.data };
  }

  async function deepSearch(query, { maxResults = 3 } = {}) {
    if (!configured) return { configured: false, results: [], error: 'FIRECRAWL_API_KEY not set' };
    try {
      const res = await fetchImpl(`${host}/v1/search`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit: maxResults, scrapeOptions: { formats: ['markdown'] } }),
      });
      if (!res.ok) throw new Error(`Firecrawl search failed: ${res.status}`);
      const data = await res.json();
      return { configured: true, results: (data.data || []).map(r => ({ title: r.title, content: r.markdown || r.content, url: r.url })) };
    } catch (err) {
      return { configured: true, results: [], error: err.message };
    }
  }

  return { configured, scrape, deepSearch };
}

module.exports = { createFirecrawlScraper };
