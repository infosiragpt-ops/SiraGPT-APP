'use strict';

/**
 * Tests for the scientific-search reliability + quality upgrades:
 *   - relevance-aware ranking (query-term coverage dominates citations)
 *   - field-merging dedup (best of every provider survives)
 *   - real socket cancellation via AbortController
 *   - transient-only retry
 *   - global wall-clock deadline with partial results
 *   - query normalisation
 * fetch is stubbed so everything runs offline + deterministically.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ss = require('../src/services/scientific-search');
const searchCache = require('../src/services/scientific-search-cache');

const originalFetch = global.fetch;
let fetchHandler = null;
function setFetchHandler(handler) {
  fetchHandler = handler;
  global.fetch = async (url, opts) => fetchHandler(String(url), opts || {});
}
function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
}
function textResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('not json'); }, text: async () => body };
}
function errorResponse(status) {
  return { ok: false, status, statusText: 'Error', json: async () => ({}), text: async () => '' };
}

test.afterEach(() => {
  fetchHandler = null;
  global.fetch = originalFetch;
  searchCache.clear();
});

// ── Relevance ranking ──────────────────────────────────────────────────

test('rankPapers(query): on-topic paper beats a more-cited off-topic one', () => {
  const { rankPapers } = ss._internal;
  const papers = [
    { title: 'A general theory of everything', openAccess: true, citations: 99999, year: 2021, abstract: '' },
    { title: 'Administrative management in public institutions', openAccess: false, citations: 3, year: 2019, abstract: 'gestion administrativa' },
  ];
  const out = rankPapers(papers, 'administrative management');
  assert.equal(out[0].title, 'Administrative management in public institutions');
});

test('rankPapers() without a query keeps the legacy OA→citations→year order', () => {
  const { rankPapers } = ss._internal;
  const papers = [
    { title: 'AAA', openAccess: false, citations: 100, year: 2020 },
    { title: 'DD', openAccess: true, citations: 50, year: 2020 },
  ];
  const out = rankPapers(papers);
  assert.equal(out[0].title, 'DD', 'open access wins when no query is supplied');
  assert.equal(out[1].title, 'AAA');
});

test('relevanceScore weights title matches above abstract matches', () => {
  const { relevanceScore, queryTerms } = ss._internal;
  const terms = queryTerms('neural networks');
  const inTitle = relevanceScore({ title: 'Neural networks for vision', abstract: '' }, terms);
  const inAbstract = relevanceScore({ title: 'A study of cats', abstract: 'we apply neural networks here' }, terms);
  assert.ok(inTitle > inAbstract, `title (${inTitle}) should outscore abstract (${inAbstract})`);
});

test('queryTerms drops stopwords + short tokens (EN/ES)', () => {
  const { queryTerms } = ss._internal;
  assert.deepEqual(queryTerms('the management of a system'), ['management', 'system']);
  assert.deepEqual(queryTerms('la gestion de las empresas'), ['gestion', 'empresas']);
});

// ── Field-merging dedup ────────────────────────────────────────────────

test('dedupeByDoi fuses complementary fields from two providers', () => {
  const { dedupeByDoi } = ss._internal;
  const arxiv = { source: 'arxiv', doi: '10.1/x', title: 'Paper', abstract: 'abs', openAccess: true, pdfUrl: 'http://pdf', citations: null };
  const crossref = { source: 'crossref', doi: '10.1/X', title: 'Paper', abstract: null, openAccess: null, pdfUrl: null, citations: 42 };
  const out = dedupeByDoi([arxiv, crossref]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pdfUrl, 'http://pdf', 'kept the arXiv PDF');
  assert.equal(out[0].citations, 42, 'kept the Crossref citation count');
  assert.equal(out[0].openAccess, true);
  assert.deepEqual(out[0].sources.slice().sort(), ['arxiv', 'crossref']);
});

test('mergePaper takes the max citation count + longer author list', () => {
  const { mergePaper } = ss._internal;
  const a = { citations: 10, authors: [{ name: 'A' }], openAccess: false };
  const b = { citations: 25, authors: [{ name: 'A' }, { name: 'B' }], openAccess: true };
  const out = mergePaper(a, b);
  assert.equal(out.citations, 25);
  assert.equal(out.authors.length, 2);
  assert.equal(out.openAccess, true);
});

// ── Query normalisation ────────────────────────────────────────────────

test('normaliseQuery collapses whitespace and strips wrapping quotes', () => {
  const { normaliseQuery } = ss._internal;
  assert.equal(normaliseQuery('  "deep   learning"  '), 'deep learning');
  assert.equal(normaliseQuery('a\n\tb'), 'a b');
  assert.equal(normaliseQuery(''), '');
});

// ── Transient classification + retry ───────────────────────────────────

test('isTransientError: retry 5xx/429/timeout, never plain 4xx', () => {
  const { isTransientError } = ss._internal;
  assert.equal(isTransientError(new Error('arxiv timed out after 50ms')), true);
  assert.equal(isTransientError(new Error('HTTP 503 Service Unavailable')), true);
  assert.equal(isTransientError(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isTransientError(new Error('HTTP 404 Not Found')), false);
  assert.equal(isTransientError(new Error('HTTP 400 Bad Request')), false);
});

test('search retries a transient (503) failure then succeeds', async () => {
  let calls = 0;
  setFetchHandler((url) => {
    if (url.includes('arxiv')) {
      calls += 1;
      if (calls === 1) return Promise.resolve(errorResponse(503));
      return Promise.resolve(textResponse('<feed><entry><id>http://arxiv.org/abs/1</id><title>Retried paper</title><published>2024-01-01</published></entry></feed>'));
    }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('x', { providers: ['arxiv'], retries: 1 });
  assert.equal(calls, 2, 'should retry once after a 503');
  assert.equal(out.papers.length, 1);
  assert.equal(out.papers[0].title, 'Retried paper');
});

test('search does NOT retry a permanent 4xx failure', async () => {
  let calls = 0;
  setFetchHandler((url) => {
    if (url.includes('arxiv')) { calls += 1; return Promise.resolve(errorResponse(404)); }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('x', { providers: ['arxiv'], retries: 2 });
  assert.equal(calls, 1, '404 is permanent — no retry');
  assert.ok(out.errors.some((e) => e.provider === 'arxiv'));
});

// ── Real socket cancellation ───────────────────────────────────────────

test('search aborts the provider socket on timeout (AbortController wired)', async () => {
  let aborted = false;
  setFetchHandler((url, opts) => {
    if (url.includes('arxiv')) {
      return new Promise((_resolve, reject) => {
        if (opts.signal) opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      });
    }
    return Promise.resolve(jsonResponse({}));
  });
  const out = await ss.search('x', { providers: ['arxiv'], timeoutMs: 40, retries: 0 });
  assert.equal(aborted, true, 'the underlying fetch signal must abort on timeout');
  assert.ok(out.errors.some((e) => e.provider === 'arxiv'));
});

// ── Global deadline / partial results ──────────────────────────────────

test('search returns partial results when the global deadline fires', async () => {
  setFetchHandler((url) => {
    if (url.includes('arxiv')) {
      return Promise.resolve(textResponse('<feed><entry><id>http://arxiv.org/abs/1</id><title>Fast paper</title><published>2024-01-01</published></entry></feed>'));
    }
    if (url.includes('openalex')) return new Promise(() => { /* never resolves */ });
    return Promise.resolve(jsonResponse({}));
  });
  const t0 = Date.now();
  const out = await ss.search('x', { providers: ['arxiv', 'openalex'], totalTimeoutMs: 150, retries: 0 });
  const elapsed = Date.now() - t0;
  assert.ok(out.papers.some((p) => p.title === 'Fast paper'), 'the fast provider result is included');
  assert.ok(elapsed < 2000, `should return near the 150ms deadline, took ${elapsed}ms`);
});
