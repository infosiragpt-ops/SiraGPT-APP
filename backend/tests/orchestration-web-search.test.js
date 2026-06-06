'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const {
  exaSearch,
  listWebSearchProviders,
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

test('listWebSearchProviders exposes DuckDuckGo as key-less fallback', () => {
  const providers = listWebSearchProviders({});
  assert.equal(providers.duckduckgo, true);
  assert.equal(providers.tavily, false);
  assert.equal(providers.exa, false);
  assert.equal(providers.firecrawl, false);
  assert.equal(providers.searxng, false);
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

test('searchFreshContext returns empty when paid and free tiers all fail', async () => {
  const fetchImpl = async () => { throw new Error('all down'); };
  // Stub the free tier so this stays hermetic (no real DuckDuckGo/Wikipedia call).
  const freeSearch = { search: async () => ({ results: [], provider: null }) };
  const result = await searchFreshContext('test', {
    env: { TAVILY_API_KEY: 'test-key', EXA_API_KEY: 'test-key' },
    fetchImpl,
    freeSearch,
  });
  assert.equal(result.provider, 'none');
  assert.equal(result.results.length, 0);
  assert.ok(result.errors.length >= 2);
});

test('searchFreshContext falls back to free key-less tier when no paid keys configured', async () => {
  const freeSearch = {
    search: async () => ({
      results: [{ title: 'Hoy', url: 'https://example.org/hoy', snippet: 'fecha actual' }],
      provider: 'duckduckgo',
    }),
  };
  const result = await searchFreshContext('qué día es hoy', { env: {}, freeSearch });
  assert.equal(result.provider, 'free:duckduckgo');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].title, 'Hoy');
  assert.equal(result.results[0].content, 'fecha actual');
});

test('searchFreshContext skips free tier when disableFreeTier is set', async () => {
  let called = false;
  const freeSearch = { search: async () => { called = true; return { results: [], provider: null }; } };
  const result = await searchFreshContext('qué día es hoy', { env: {}, freeSearch, disableFreeTier: true });
  assert.equal(result.provider, 'none');
  assert.equal(called, false);
});
