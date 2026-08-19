'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const {
  exaSearch,
  needsFreshWebContext,
  searchFreshContext,
  tavilySearch,
} = require('../src/orchestration/web-search-tools');

test('needsFreshWebContext detects time-sensitive queries', () => {
  assert.equal(needsFreshWebContext(''), false);
  assert.equal(needsFreshWebContext('qué pasó hoy en bolsa'), true);
  assert.equal(needsFreshWebContext('latest research papers 2026'), true);
  assert.equal(needsFreshWebContext('noticias actuales de IA'), true);
  assert.equal(needsFreshWebContext('precio del bitcoin ahora'), true);
  assert.equal(needsFreshWebContext('últimos avances en medicina'), true);
  assert.equal(needsFreshWebContext('explica el teorema de Pitágoras'), false);
  assert.equal(needsFreshWebContext('cómo hacer una tesis'), false);
});

test('tavilySearch returns empty when not configured', async () => {
  const result = await tavilySearch('test query', { env: {} });
  assert.deepEqual(result, { provider: 'tavily', configured: false, results: [] });
});

test('tavilySearch fails gracefully on network errors', async () => {
  const fetchImpl = async () => { throw new Error('network error'); };
  await assert.rejects(
    () => tavilySearch('test', { env: { TAVILY_API_KEY: 'test-key' }, fetchImpl }),
    /network error/,
  );
});

test('exaSearch returns empty when not configured', async () => {
  const result = await exaSearch('test query', { env: {} });
  assert.deepEqual(result, { provider: 'exa', configured: false, results: [] });
});

test('exaSearch fails gracefully on network errors', async () => {
  const fetchImpl = async () => { throw new Error('network error'); };
  await assert.rejects(
    () => exaSearch('test', { env: { EXA_API_KEY: 'test-key' }, fetchImpl }),
    /network error/,
  );
});

test('searchFreshContext returns tavily results when configured', async () => {
  const mockResults = [{ title: 'Test', url: 'https://example.com', content: 'test content' }];
  const fetchImpl = async (url) => {
    if (url.includes('tavily')) {
      return { ok: true, json: async () => ({ results: mockResults }) };
    }
    return { ok: false, status: 500 };
  };
  const result = await searchFreshContext('test', {
    env: { TAVILY_API_KEY: 'test-key' },
    fetchImpl,
  });
  assert.equal(result.provider, 'tavily');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Test');
});

test('searchFreshContext falls back to exa when tavily fails', async () => {
  const mockResults = [{ title: 'Exa Result', url: 'https://exa.com', content: 'exa content' }];
  const fetchImpl = async (url) => {
    if (url.includes('tavily')) throw new Error('tavily down');
    if (url.includes('exa')) {
      return { ok: true, json: async () => ({ results: mockResults }) };
    }
    return { ok: false, status: 500 };
  };
  const result = await searchFreshContext('test', {
    env: { TAVILY_API_KEY: 'test-key', EXA_API_KEY: 'test-key' },
    fetchImpl,
  });
  assert.equal(result.provider, 'exa');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Exa Result');
});

test('searchFreshContext returns empty when both providers fail', async () => {
  const fetchImpl = async () => { throw new Error('all down'); };
  const result = await searchFreshContext('test', {
    env: { TAVILY_API_KEY: 'test-key', EXA_API_KEY: 'test-key' },
    fetchImpl,
  });
  assert.equal(result.provider, 'none');
  assert.equal(result.results.length, 0);
  assert.ok(result.errors.length >= 2);
});
