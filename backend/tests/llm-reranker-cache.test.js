'use strict';

/**
 * Phase 8E.2 — focused regressions for the quick-lru-backed rerank cache.
 * Complements tests/llm-reranker.test.js (rerank flow) and
 * tests/audit2.test.js (CACHE_MAX hard-cap under steady load).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const reranker = require('../src/services/llm-reranker');

function makeStub() {
  let calls = 0;
  return {
    get calls() { return calls; },
    client: {
      chat: { completions: { create: async () => {
        calls += 1;
        return {
          choices: [{ message: { content: JSON.stringify({ rankings: [
            { passage_number: 1, score: 0.9 },
            { passage_number: 2, score: 0.5 },
            { passage_number: 3, score: 0.1 },
          ]})}}],
        };
      } } },
    },
  };
}

const CANDIDATES = [
  { text: 'doc-a', score: 0.91 },
  { text: 'doc-b', score: 0.80 },
  { text: 'doc-c', score: 0.75 },
];

test('rerank cache hit avoids a second LLM call for the same query+ids', async () => {
  await reranker.clearCache();
  const stub = makeStub();
  await reranker.rerank(stub.client, 'cache-hit-query', CANDIDATES);
  await reranker.rerank(stub.client, 'cache-hit-query', CANDIDATES);
  assert.equal(stub.calls, 1, 'second call should hit cache');
});

test('rerank cache misses for a different query', async () => {
  await reranker.clearCache();
  const stub = makeStub();
  await reranker.rerank(stub.client, 'query-A', CANDIDATES);
  await reranker.rerank(stub.client, 'query-B', CANDIDATES);
  assert.equal(stub.calls, 2);
});

test('clearCache empties the cache between runs', async () => {
  await reranker.clearCache();
  const stub = makeStub();
  await reranker.rerank(stub.client, 'cleared-query', CANDIDATES);
  await reranker.clearCache();
  await reranker.rerank(stub.client, 'cleared-query', CANDIDATES);
  assert.equal(stub.calls, 2, 'cache should miss after clear');
  assert.equal(await reranker.cacheSize(), 1);
});

test('cache size never exceeds CACHE_MAX even if maxAge has not elapsed', async () => {
  await reranker.clearCache();
  const stub = makeStub();
  // Fill twice the cap with distinct queries.
  for (let i = 0; i < reranker.CACHE_MAX * 2; i++) {
    await reranker.rerank(stub.client, `bulk-${i}`, CANDIDATES);
  }
  assert.ok(
    (await reranker.cacheSize()) <= reranker.CACHE_MAX,
    'quick-lru must hard-cap at CACHE_MAX',
  );
});
