'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFirecrawlScraper } = require('../src/services/web-scraping/firecrawl-adapter');

test('exports createFirecrawlScraper', () => {
  assert.equal(typeof createFirecrawlScraper, 'function');
});

test('configured=false when FIRECRAWL_API_KEY is absent', () => {
  const scraper = createFirecrawlScraper({ env: {} });
  assert.equal(scraper.configured, false);
});

test('configured=true when FIRECRAWL_API_KEY is set', () => {
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk-fire' } });
  assert.equal(scraper.configured, true);
});

test('scrape returns {configured:false, results:null} when not configured', async () => {
  const scraper = createFirecrawlScraper({ env: {} });
  const out = await scraper.scrape('https://example.com');
  assert.deepEqual(out, { configured: false, results: null });
});

test('scrape posts to /v1/scrape with Bearer auth + correct body', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, async json() { return { data: { markdown: '# Title' } }; } };
  };
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk-fire' }, fetchImpl });
  const out = await scraper.scrape('https://example.com');
  assert.equal(captured.url, 'https://api.firecrawl.dev/v1/scrape');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer sk-fire');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.url, 'https://example.com');
  assert.deepEqual(body.formats, ['markdown']);
  assert.equal(body.onlyMainContent, true);
  assert.equal(out.configured, true);
  assert.deepEqual(out.results, { markdown: '# Title' });
});

test('scrape honours FIRECRAWL_HOST override', async () => {
  let captured = null;
  const fetchImpl = async (url) => { captured = url; return { ok: true, async json() { return { data: {} }; } }; };
  const scraper = createFirecrawlScraper({
    env: { FIRECRAWL_API_KEY: 'sk', FIRECRAWL_HOST: 'https://self.firecrawl.local' },
    fetchImpl,
  });
  await scraper.scrape('https://example.com');
  assert.equal(captured, 'https://self.firecrawl.local/v1/scrape');
});

test('scrape allows opts.formats override and opts.onlyMainContent=false', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = JSON.parse(opts.body); return { ok: true, async json() { return { data: {} }; } }; };
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  await scraper.scrape('https://example.com', { formats: ['markdown', 'html'], onlyMainContent: false });
  assert.deepEqual(captured.formats, ['markdown', 'html']);
  assert.equal(captured.onlyMainContent, false);
});

test('scrape throws with .status when the response is not ok', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, async json() { return {}; } });
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  await assert.rejects(
    () => scraper.scrape('https://example.com'),
    (err) => err.status === 429 && /Firecrawl failed: 429/.test(err.message),
  );
});

test('deepSearch returns {configured:false, results:[]} when not configured', async () => {
  const scraper = createFirecrawlScraper({ env: {} });
  const out = await scraper.deepSearch('quantum mechanics');
  assert.deepEqual(out, { configured: false, results: [] });
});

test('deepSearch posts to /v1/search with the query + limit', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return { ok: true, async json() { return { data: [{ title: 'T', markdown: 'M', url: 'https://u' }] }; } };
  };
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  const out = await scraper.deepSearch('quantum', { maxResults: 5 });
  assert.equal(captured.url, 'https://api.firecrawl.dev/v1/search');
  assert.equal(captured.body.query, 'quantum');
  assert.equal(captured.body.limit, 5);
  assert.deepEqual(out.results, [{ title: 'T', content: 'M', url: 'https://u' }]);
});

test('deepSearch defaults maxResults to 3 when not provided', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = JSON.parse(opts.body); return { ok: true, async json() { return { data: [] }; } }; };
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  await scraper.deepSearch('q');
  assert.equal(captured.limit, 3);
});

test('deepSearch swallows errors and returns {configured:true, results:[], error}', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, async json() { return {}; } });
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  const out = await scraper.deepSearch('q');
  assert.equal(out.configured, true);
  assert.deepEqual(out.results, []);
  assert.match(out.error || '', /Firecrawl search failed: 500/);
});

test('deepSearch result content falls back to .content when .markdown is absent', async () => {
  const fetchImpl = async () => ({ ok: true, async json() { return { data: [{ title: 'T', content: 'fallback', url: 'u' }] }; } });
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  const out = await scraper.deepSearch('q');
  assert.equal(out.results[0].content, 'fallback');
});

// --- request timeout (AbortSignal) -----------------------------------------
// A fetch that never resolves until its AbortSignal fires — models a hung
// Firecrawl service so the timeout path is deterministic + offline.
const hangUntilAbort = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
});

test('scrape passes an AbortSignal in the request init', async () => {
  let captured = null;
  const fetchImpl = async (_url, opts) => { captured = opts; return { ok: true, async json() { return { data: {} }; } }; };
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl });
  await scraper.scrape('https://example.com');
  assert.ok(captured.signal instanceof AbortSignal, 'init.signal must be an AbortSignal');
});

test('scrape rejects (does not hang) when the request times out', async () => {
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl: hangUntilAbort });
  await assert.rejects(() => scraper.scrape('https://example.com', { timeoutMs: 10 }));
});

test('deepSearch bounds the request and swallows an abort', async () => {
  const scraper = createFirecrawlScraper({ env: { FIRECRAWL_API_KEY: 'sk' }, fetchImpl: hangUntilAbort });
  const out = await scraper.deepSearch('q', { timeoutMs: 10 });
  assert.equal(out.configured, true);
  assert.deepEqual(out.results, []);
  assert.ok(out.error, 'returns an error string instead of hanging');
});
