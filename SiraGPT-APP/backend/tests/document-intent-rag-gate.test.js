'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeIntentList, rankSources } = require('../src/services/document-intent-rag-gate');

test('exports normalizeIntentList + rankSources', () => {
  assert.equal(typeof normalizeIntentList, 'function');
  assert.equal(typeof rankSources, 'function');
});

test('normalizeIntentList returns [] for falsy / missing input', () => {
  assert.deepEqual(normalizeIntentList(null), []);
  assert.deepEqual(normalizeIntentList(undefined), []);
  assert.deepEqual(normalizeIntentList({}), []);
  assert.deepEqual(normalizeIntentList({ perDocument: 'not-an-array' }), []);
});

test('normalizeIntentList reads from perDocument key', () => {
  const out = normalizeIntentList({
    perDocument: [
      { fileId: 'f1', domain: 'legal', relevanceScore: 0.9, role: 'primary' },
      { fileId: 'f2', primaryDomain: 'medical', score: 0.4, intent: 'supporting' },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].fileId, 'f1');
  assert.equal(out[0].domain, 'legal');
  assert.equal(out[0].relevance, 0.9);
  assert.equal(out[0].role, 'primary');
  assert.equal(out[1].domain, 'medical');
  assert.equal(out[1].relevance, 0.4);
  assert.equal(out[1].role, 'supporting');
});

test('normalizeIntentList falls back to documents key when perDocument is missing', () => {
  const out = normalizeIntentList({
    documents: [
      { id: 'd1', relevanceScore: 0.7 },
      { source: 'd2', score: 0.2 },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].fileId, 'd1');
  assert.equal(out[1].fileId, 'd2');
});

test('normalizeIntentList drops entries without an id/source', () => {
  const out = normalizeIntentList({
    perDocument: [
      { fileId: 'f1', relevanceScore: 0.9 },
      { relevanceScore: 0.5 }, // no fileId — must be dropped
      { source: 'f3', relevanceScore: 0.4 },
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((d) => d.fileId), ['f1', 'f3']);
});

test('normalizeIntentList defaults relevance to 0.5 and role to "supporting" when missing', () => {
  const out = normalizeIntentList({
    perDocument: [{ fileId: 'a' }],
  });
  assert.equal(out[0].relevance, 0.5);
  assert.equal(out[0].role, 'supporting');
  assert.equal(out[0].domain, 'general');
});

test('rankSources returns input unchanged when no intent analysis is provided', () => {
  const sources = [{ fileId: 'a' }, { fileId: 'b' }];
  const out = rankSources(sources, null);
  assert.equal(out.gated, false);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.sources, sources);
});

test('rankSources filters out low-relevance sources below the threshold', () => {
  const sources = [
    { fileId: 'high', title: 'high relevance' },
    { fileId: 'low', title: 'low relevance' },
  ];
  const intent = {
    perDocument: [
      { fileId: 'high', relevanceScore: 0.8 },
      { fileId: 'low', relevanceScore: 0.1 },
    ],
  };
  const out = rankSources(sources, intent, { minRelevance: 0.5 });
  assert.equal(out.gated, true);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].fileId, 'high');
  assert.equal(out.dropped, 1);
});

test('rankSources keeps "primary" role sources even when relevance is below threshold', () => {
  const sources = [{ fileId: 'a' }];
  const intent = {
    perDocument: [{ fileId: 'a', relevanceScore: 0.1, role: 'primary' }],
  };
  const out = rankSources(sources, intent, { minRelevance: 0.5 });
  assert.equal(out.sources.length, 1, 'primary role wins even with low relevance');
});

test('rankSources sorts kept sources by relevance descending', () => {
  const sources = [{ fileId: 'a' }, { fileId: 'b' }, { fileId: 'c' }];
  const intent = {
    perDocument: [
      { fileId: 'a', relevanceScore: 0.4 },
      { fileId: 'b', relevanceScore: 0.9 },
      { fileId: 'c', relevanceScore: 0.6 },
    ],
  };
  const out = rankSources(sources, intent, { minRelevance: 0.3 });
  assert.deepEqual(out.sources.map((s) => s.fileId), ['b', 'c', 'a']);
});

test('rankSources falls back to the first 3 sources when nothing survives the filter', () => {
  const sources = [{ fileId: 'a' }, { fileId: 'b' }, { fileId: 'c' }, { fileId: 'd' }, { fileId: 'e' }];
  const intent = {
    perDocument: [
      { fileId: 'a', relevanceScore: 0.01 },
      { fileId: 'b', relevanceScore: 0.02 },
      { fileId: 'c', relevanceScore: 0.03 },
      { fileId: 'd', relevanceScore: 0.04 },
      { fileId: 'e', relevanceScore: 0.05 },
    ],
  };
  const out = rankSources(sources, intent, { minRelevance: 0.9 });
  // Nothing passes 0.9 → fallback to first 3
  assert.equal(out.sources.length, 3);
  assert.equal(out.dropped, 2);
});

test('rankSources includes a rankings array with relevance scores', () => {
  const sources = [{ fileId: 'high' }, { fileId: 'low' }];
  const intent = {
    perDocument: [
      { fileId: 'high', relevanceScore: 0.9 },
      { fileId: 'low', relevanceScore: 0.6 },
    ],
  };
  const out = rankSources(sources, intent, { minRelevance: 0.5 });
  assert.equal(out.rankings.length, 2);
  assert.equal(out.rankings[0].id, 'high');
  assert.equal(out.rankings[0].relevance, 0.9);
  assert.equal(out.rankings[1].id, 'low');
});

test('rankSources tolerates non-array sources input', () => {
  const out = rankSources(null, { perDocument: [{ fileId: 'a', relevanceScore: 1 }] });
  assert.equal(Array.isArray(out.sources), true);
  assert.equal(out.sources.length, 0);
});
