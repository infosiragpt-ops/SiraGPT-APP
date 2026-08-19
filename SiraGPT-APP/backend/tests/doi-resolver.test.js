'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearDoiResolutionCache,
  resolveDoi,
  resolvePaperDois,
} = require('../src/services/research/doi-resolver');

test.beforeEach(() => clearDoiResolutionCache());

test('resolveDoi rejects invalid syntax without making a network call', async () => {
  let calls = 0;
  const result = await resolveDoi('not-a-doi', { fetchImpl: async () => { calls++; } });
  assert.equal(result.status, 'invalid');
  assert.equal(calls, 0);
});

test('resolveDoi follows a live destination and caches the confirmation', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, url: 'https://publisher.example/article/123', headers: new Map() };
  };
  const first = await resolveDoi('https://doi.org/10.1234/ABC.1', { fetchImpl });
  const second = await resolveDoi('10.1234/abc.1', { fetchImpl });
  assert.equal(first.status, 'resolved');
  assert.equal(first.canonicalUrl, 'https://publisher.example/article/123');
  assert.equal(first.cacheHit, false);
  assert.equal(second.status, 'resolved');
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('resolveDoi records authoritative 404 separately from transient failures', async () => {
  const result = await resolveDoi('10.1234/missing', {
    fetchImpl: async () => ({ ok: false, status: 404, url: 'https://doi.org/10.1234/missing', headers: new Map() }),
  });
  assert.equal(result.status, 'not_found');
  assert.equal(result.httpStatus, 404);
});

test('resolveDoi bounds a stalled request with a timeout', async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const result = await resolveDoi('10.1234/slow', { fetchImpl, timeoutMs: 20 });
  assert.equal(result.status, 'timeout');
});

test('resolvePaperDois annotates only valid DOI candidates and preserves editorial alerts', async () => {
  const papers = await resolvePaperDois([
    { title: 'A', doi: '10.1234/a', integrityStatus: 'corrected' },
    { title: 'B', doi: 'invalid' },
  ], {
    fetchImpl: async () => ({ ok: true, status: 200, url: 'https://publisher.example/a', headers: new Map() }),
  });
  assert.equal(papers[0].doiResolutionStatus, 'resolved');
  assert.equal(papers[0].editorialStatus, 'corrected');
  assert.equal(papers[1].doiResolutionStatus, undefined);
});
