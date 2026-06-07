/**
 * Tests for the web-search relevance module + the adapter's aggregating
 * `searchMany` path.
 *
 * These guard the fix for the "¿qué día es hoy?" → random DOI papers bug:
 *   - relevance.contentTokens() strips stopwords + temporal noise so a
 *     content-free prompt yields no tokens (and therefore no sources).
 *   - relevance.rankAndFilter() drops irrelevant results, dedupes and ranks.
 *   - searchMany() fans out in parallel, merges providers, filters by
 *     relevance, and excludes the scientific tier for casual prompts.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const relevance = require('../src/services/agents/web-search/relevance');
const webSearch = require('../src/services/agents/web-search');
const auditLog = require('../src/services/agents/audit-log');

const originalAudit = auditLog.audit;
beforeEach(() => {
  webSearch.resetProviders();
  webSearch.clearCache();
  auditLog.audit = () => {};
});
afterEach(() => {
  auditLog.audit = originalAudit;
  webSearch.resetProviders();
  webSearch.clearCache();
});

function provider({ id, priority = 100, results = [], delay = 0, throws = null }) {
  return {
    id,
    name: id,
    priority,
    enabled: true,
    async search(query, opts) {
      if (delay) {
        await new Promise((r, rj) => {
          const t = setTimeout(r, delay);
          if (opts?.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); rj(new Error('aborted')); });
        });
      }
      if (throws) throw new Error(throws);
      return results;
    },
  };
}

// ── relevance.contentTokens ──────────────────────────────────────────

test('contentTokens drops stopwords + temporal noise for "¿qué día es hoy?"', () => {
  assert.deepEqual(relevance.contentTokens('¿qué día es hoy?'), []);
  assert.deepEqual(relevance.contentTokens('que dia es hoy'), []);
  assert.deepEqual(relevance.contentTokens('what day is it today'), []);
});

test('contentTokens keeps meaningful words and is accent-insensitive', () => {
  assert.deepEqual(relevance.contentTokens('precio del bitcoin hoy'), ['precio', 'bitcoin']);
  assert.deepEqual(relevance.contentTokens('investigación sobre el cáncer'), ['investigacion', 'cancer']);
});

// ── relevance.scoreResult ────────────────────────────────────────────

test('scoreResult is 0 for a content-free query (nothing to match)', () => {
  const paper = { title: 'La biodiversidad de la Tierra es hoy más rica que nunca', url: 'https://doi.org/x', snippet: '' };
  assert.equal(relevance.scoreResult('que dia es hoy', paper), 0);
});

test('scoreResult rewards title hits over snippet-only hits', () => {
  const inTitle = { title: 'Bitcoin price analysis', url: 'https://a.test', snippet: 'markets' };
  const inSnippet = { title: 'Markets weekly', url: 'https://b.test', snippet: 'bitcoin moved' };
  const q = 'bitcoin price';
  assert.ok(relevance.scoreResult(q, inTitle) > relevance.scoreResult(q, inSnippet));
});

// ── relevance.rankAndFilter ──────────────────────────────────────────

test('rankAndFilter returns [] for a content-free query', () => {
  const results = [
    { title: 'La biodiversidad de la Tierra', url: 'https://doi.org/1', snippet: 'hoy' },
    { title: 'Elecciones 2006', url: 'https://doi.org/2', snippet: '' },
  ];
  assert.deepEqual(relevance.rankAndFilter('que dia es hoy', results), []);
});

test('rankAndFilter drops irrelevant, ranks + dedupes relevant', () => {
  const results = [
    { title: 'Transformers neural networks explained', url: 'https://x.test/a', snippet: 'attention' },
    { title: 'Unrelated cooking recipe', url: 'https://y.test/b', snippet: 'pasta and cheese' },
    // duplicate URL (trailing slash) of the first, weaker title → deduped away
    { title: 'transformers', url: 'https://x.test/a/', snippet: '' },
  ];
  const ranked = relevance.rankAndFilter('transformers neural networks', results, { minScore: 0.3 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].url, 'https://x.test/a');
  assert.equal(typeof ranked[0]._score, 'number');
});

test('rankAndFilter caps to the limit', () => {
  const results = Array.from({ length: 20 }, (_, i) => ({
    title: `bitcoin price report ${i}`, url: `https://n.test/${i}`, snippet: 'bitcoin',
  }));
  const ranked = relevance.rankAndFilter('bitcoin price', results, { limit: 5 });
  assert.equal(ranked.length, 5);
});

test('rankAndFilter floats authoritative (.gov/.edu) sources above unknown ones', () => {
  const results = [
    { title: 'Vaccine safety overview', url: 'https://random-blog.example/vaccine', snippet: 'vaccine safety data' },
    { title: 'Vaccine safety overview', url: 'https://cdc.gov/vaccine', snippet: 'vaccine safety data' },
  ];
  const ranked = relevance.rankAndFilter('vaccine safety', results);
  assert.equal(ranked[0].url, 'https://cdc.gov/vaccine', 'authoritative domain should rank first');
});

test('rankAndFilter per-domain cap limits a dominating site', () => {
  const results = [
    { title: 'bitcoin a', url: 'https://news.example/a', snippet: 'bitcoin' },
    { title: 'bitcoin b', url: 'https://news.example/b', snippet: 'bitcoin' },
    { title: 'bitcoin c', url: 'https://news.example/c', snippet: 'bitcoin' },
    { title: 'bitcoin d', url: 'https://other.example/d', snippet: 'bitcoin' },
  ];
  const ranked = relevance.rankAndFilter('bitcoin', results, { perDomain: 2 });
  const newsCount = ranked.filter((r) => /news\.example/.test(r.url)).length;
  assert.ok(newsCount <= 2, `news.example capped at 2, got ${newsCount}`);
  assert.ok(ranked.some((r) => /other\.example/.test(r.url)));
});

test('rankAndFilter exempts aggregator hosts (doi.org) from the per-domain cap', () => {
  const results = [
    { title: 'cancer study a', url: 'https://doi.org/a', snippet: 'cancer study' },
    { title: 'cancer study b', url: 'https://doi.org/b', snippet: 'cancer study' },
    { title: 'cancer study c', url: 'https://doi.org/c', snippet: 'cancer study' },
  ];
  const ranked = relevance.rankAndFilter('cancer study', results, { perDomain: 1 });
  assert.equal(ranked.length, 3, 'distinct doi.org papers must not be collapsed');
});

// ── adapter.isScientificQuery ────────────────────────────────────────

test('isScientificQuery flags research asks, not casual prompts', () => {
  assert.equal(webSearch.isScientificQuery('estudios sobre el cáncer de mama'), true);
  assert.equal(webSearch.isScientificQuery('papers recientes sobre transformers'), true);
  assert.equal(webSearch.isScientificQuery('meta-análisis de la vitamina D'), true);
  assert.equal(webSearch.isScientificQuery('precio del bitcoin'), false);
  assert.equal(webSearch.isScientificQuery('qué día es hoy'), false);
  assert.equal(webSearch.isScientificQuery('noticias de hoy'), false);
});

// ── adapter.searchMany ───────────────────────────────────────────────

test('searchMany merges + relevance-filters across providers in parallel', async () => {
  webSearch.setProviders([
    provider({ id: 'duckduckgo', priority: 10, results: [
      { title: 'Bitcoin price hits new high', url: 'https://a.test/1', snippet: 'bitcoin price' },
      { title: 'Totally unrelated gardening', url: 'https://a.test/weeds', snippet: 'roses' },
    ] }),
    provider({ id: 'wikipedia', priority: 20, results: [
      { title: 'Bitcoin', url: 'https://en.wikipedia.org/wiki/Bitcoin', snippet: 'price and history' },
    ] }),
  ]);
  const out = await webSearch.searchMany('bitcoin price', { maxResults: 10 });
  const urls = out.results.map((r) => r.url);
  assert.ok(urls.includes('https://a.test/1'));
  assert.ok(urls.includes('https://en.wikipedia.org/wiki/Bitcoin'));
  assert.ok(!urls.includes('https://a.test/weeds'), 'irrelevant result should be filtered out');
  assert.match(out.provider || '', /^aggregate:/);
});

test('searchMany excludes the scientific tier for casual prompts', async () => {
  let crossrefHit = false;
  webSearch.setProviders([
    { id: 'crossref', name: 'crossref', priority: 3, enabled: true,
      async search() { crossrefHit = true; return [{ title: 'bitcoin paper', url: 'https://doi.org/z', snippet: 'bitcoin' }]; } },
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() { return [{ title: 'Bitcoin price report', url: 'https://a.test/1', snippet: 'bitcoin price' }]; } },
  ]);
  const out = await webSearch.searchMany('precio del bitcoin', { maxResults: 10 });
  assert.equal(crossrefHit, false, 'scientific provider must NOT run for a casual prompt');
  assert.ok(out.results.every((r) => !/doi\.org/.test(r.url)));
});

test('searchMany includes the scientific tier for research prompts', async () => {
  let crossrefHit = false;
  webSearch.setProviders([
    { id: 'crossref', name: 'crossref', priority: 3, enabled: true,
      async search() { crossrefHit = true; return [{ title: 'cancer study results', url: 'https://doi.org/study', snippet: 'cancer' }]; } },
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() { return [{ title: 'cancer overview', url: 'https://a.test/c', snippet: 'cancer' }]; } },
  ]);
  const out = await webSearch.searchMany('estudios sobre el cancer', { maxResults: 10 });
  assert.equal(crossrefHit, true, 'scientific provider SHOULD run for a research prompt');
  assert.ok(out.results.some((r) => /doi\.org/.test(r.url)));
});

test('searchMany short-circuits a content-free query without touching providers', async () => {
  let touched = false;
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() { touched = true; return [{ title: 'x', url: 'https://x.test', snippet: '' }]; } },
  ]);
  const out = await webSearch.searchMany('¿qué día es hoy?', { maxResults: 10 });
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, null);
  assert.equal(touched, false);
});

test('searchMany survives a slow provider (parallel + per-provider timeout)', async () => {
  webSearch.setProviders([
    provider({ id: 'slow', priority: 10, delay: 1000, results: [{ title: 'bitcoin late', url: 'https://late.test', snippet: 'bitcoin' }] }),
    provider({ id: 'fast', priority: 20, results: [{ title: 'bitcoin price now', url: 'https://fast.test', snippet: 'bitcoin price' }] }),
  ]);
  const out = await webSearch.searchMany('bitcoin price', { maxResults: 10, timeoutMs: 100 });
  const urls = out.results.map((r) => r.url);
  assert.ok(urls.includes('https://fast.test'));
  assert.ok(!urls.includes('https://late.test'));
});

test('searchMany caches merged results by (query, locale, tier)', async () => {
  let calls = 0;
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() { calls += 1; return [{ title: 'bitcoin price', url: 'https://a.test/1', snippet: 'bitcoin price' }]; } },
  ]);
  const first = await webSearch.searchMany('bitcoin price', { maxResults: 10 });
  assert.equal(first.cached, false);
  const second = await webSearch.searchMany('bitcoin price', { maxResults: 10 });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('searchMany _force bypasses the cache and re-queries providers', async () => {
  let calls = 0;
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() { calls += 1; return [{ title: 'bitcoin price', url: 'https://a.test/1', snippet: 'bitcoin price' }]; } },
  ]);
  await webSearch.searchMany('bitcoin price', { maxResults: 10 });
  assert.equal(calls, 1);
  const forced = await webSearch.searchMany('bitcoin price', { maxResults: 10, _force: true });
  assert.equal(forced.cached, false);
  assert.equal(calls, 2, '_force must skip the cache read and hit providers again');
});

test('searchMany caps results per domain for general-web queries', async () => {
  webSearch.setProviders([
    { id: 'duckduckgo', name: 'duckduckgo', priority: 10, enabled: true,
      async search() {
        return Array.from({ length: 10 }, (_, i) => ({
          title: `bitcoin price story ${i}`, url: `https://onesite.example/p${i}`, snippet: 'bitcoin price',
        }));
      } },
  ]);
  const out = await webSearch.searchMany('bitcoin price', { maxResults: 50 });
  const sameDomain = out.results.filter((r) => /onesite\.example/.test(r.url)).length;
  assert.ok(sameDomain <= 6, `expected per-domain diversity cap (<=6), got ${sameDomain}`);
});
