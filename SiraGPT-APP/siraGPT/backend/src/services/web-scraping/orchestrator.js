'use strict';

const { searchFreshContext } = require('../../orchestration/web-search-tools');

let _firecrawl = null;
function getFirecrawl() {
  if (_firecrawl) return _firecrawl;
  try { _firecrawl = require('./firecrawl-adapter').createFirecrawlScraper(); } catch (_) { _firecrawl = { configured: false }; }
  return _firecrawl;
}

let _searxng = null;
function getSearXNG() {
  if (_searxng) return _searxng;
  try { _searxng = require('./searxng-adapter').createSearXNGSearcher(); } catch (_) { _searxng = { configured: false }; }
  return _searxng;
}

async function deepSearch(query, opts = {}) {
  const errors = [];
  try {
    const primary = await searchFreshContext(query, opts);
    if (primary.results?.length) return { ...primary, source: 'api_search' };
  } catch (err) { errors.push({ provider: 'tavily_exa', message: err.message }); }

  const firecrawl = getFirecrawl();
  if (firecrawl.configured) {
    try {
      const fcResult = await firecrawl.deepSearch(query, opts);
      if (fcResult.results?.length) return { ...fcResult, provider: 'firecrawl', source: 'deep_search' };
    } catch (err) { errors.push({ provider: 'firecrawl', message: err.message }); }
  }

  const searxng = getSearXNG();
  if (searxng.configured) {
    try {
      const sxResult = await searxng.search(query, { maxResults: opts.maxResults || 5 });
      if (sxResult.results?.length) return { provider: 'searxng', configured: true, results: sxResult.results, source: 'meta_search' };
    } catch (err) { errors.push({ provider: 'searxng', message: err.message }); }
  }

  return { provider: 'none', configured: false, results: [], errors };
}

module.exports = { deepSearch, getFirecrawl, getSearXNG };
