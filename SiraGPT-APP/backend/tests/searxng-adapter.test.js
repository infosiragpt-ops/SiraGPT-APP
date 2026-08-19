'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSearXNGSearcher } = require('../src/services/web-scraping/searxng-adapter');

// `configured` is derived from process.env.SEARXNG_URL at factory time, so each
// test sets/clears it explicitly and restores the original afterwards.
function withSearxngUrl(value, fn) {
  const prev = process.env.SEARXNG_URL;
  if (value === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.SEARXNG_URL;
    else process.env.SEARXNG_URL = prev;
  }
}

// A fetch that only settles when its AbortSignal fires — models a hung SearXNG.
const hangUntilAbort = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
});

test('exports createSearXNGSearcher', () => {
  assert.equal(typeof createSearXNGSearcher, 'function');
});

test('not configured → returns {configured:false} WITHOUT calling fetch', async () => {
  await withSearxngUrl(undefined, async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, async json() { return {}; } }; };
    const searcher = createSearXNGSearcher({ fetchImpl });
    const out = await searcher.search('q');
    assert.deepEqual(out, { configured: false, results: [] });
    assert.equal(called, false, 'must not hit the network when unconfigured');
  });
});

test('search passes an AbortSignal in the request init', async () => {
  await withSearxngUrl('http://localhost:8080', async () => {
    let captured = null;
    const fetchImpl = async (_url, init) => { captured = init; return { ok: true, async json() { return { results: [] }; } }; };
    const searcher = createSearXNGSearcher({ fetchImpl });
    await searcher.search('q');
    assert.ok(captured && captured.signal instanceof AbortSignal, 'init.signal must be an AbortSignal');
  });
});

test('search rejects (does not hang) when the request times out', async () => {
  await withSearxngUrl('http://localhost:8080', async () => {
    const searcher = createSearXNGSearcher({ fetchImpl: hangUntilAbort });
    await assert.rejects(() => searcher.search('q', { timeoutMs: 10 }));
  });
});

test('happy path maps SearXNG results', async () => {
  await withSearxngUrl('http://localhost:8080', async () => {
    const fetchImpl = async () => ({
      ok: true,
      async json() { return { results: [{ title: 'T', content: 'C', url: 'https://u', engine: 'duck' }] }; },
    });
    const searcher = createSearXNGSearcher({ fetchImpl });
    const out = await searcher.search('q', { maxResults: 5 });
    assert.equal(out.configured, true);
    assert.deepEqual(out.results, [{ title: 'T', snippet: 'C', url: 'https://u', engine: 'duck' }]);
  });
});

test('non-ok response surfaces an error without throwing', async () => {
  await withSearxngUrl('http://localhost:8080', async () => {
    const searcher = createSearXNGSearcher({ fetchImpl: async () => ({ ok: false, status: 502 }) });
    const out = await searcher.search('q');
    assert.equal(out.configured, true);
    assert.deepEqual(out.results, []);
    assert.match(out.error || '', /502/);
  });
});
