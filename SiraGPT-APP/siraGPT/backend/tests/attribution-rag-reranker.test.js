'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/services/attribution-rag-reranker');

describe('attribution-rag-reranker', () => {
  test('empty snippets returns empty array', () => {
    assert.deepEqual(r.rerank({ prompt: 'foo', snippets: [] }), []);
  });
  test('snippets matching prompt concepts get boosted', () => {
    const snippets = [
      { id: 'a', text: 'a generic note about the weather', score: 0.5 },
      { id: 'b', text: 'frontend Login Component bug fix snippet about UI', score: 0.5 },
    ];
    const ranked = r.rerank({ prompt: 'arregla el bug del frontend Login Component', snippets });
    assert.equal(ranked[0].original.id, 'b');
  });
  test('weight=0 falls back to base score', () => {
    const snippets = [
      { id: 'low', text: 'frontend UI', score: 0.2 },
      { id: 'high', text: 'totally unrelated', score: 0.9 },
    ];
    const ranked = r.rerank({ prompt: 'arregla el frontend', snippets, weight: 0 });
    assert.equal(ranked[0].original.id, 'high');
  });
  test('weight=1 ignores base score entirely', () => {
    const snippets = [
      { id: 'match', text: 'frontend UI', score: 0.01 },
      { id: 'nomatch', text: 'totally unrelated', score: 0.99 },
    ];
    const ranked = r.rerank({ prompt: 'arregla el frontend', snippets, weight: 1 });
    assert.equal(ranked[0].original.id, 'match');
  });
  test('caps results to max', () => {
    const snippets = Array.from({ length: 10 }, (_, i) => ({ text: `snippet ${i}` }));
    const ranked = r.rerank({ prompt: 'x', snippets, max: 3 });
    assert.equal(ranked.length, 3);
  });
  test('buildRerankBlock yields content', () => {
    const ranked = r.rerank({ prompt: 'arregla el frontend Login', snippets: [{ text: 'frontend Login Component fix' }, { text: 'algo random' }] });
    const block = r.buildRerankBlock(ranked);
    assert.match(block, /RAG REORDER NOTE/);
  });
});
