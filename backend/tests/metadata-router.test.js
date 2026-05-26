/**
 * Tests for metadata-based filtering + semantic query router.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const mr = require('../src/services/rag/metadata-router');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── matchesCondition (operators) ────────────────────────────────────────

test('matchesCondition: scalar equality', () => {
  assert.equal(mr.matchesCondition('a', 'a'), true);
  assert.equal(mr.matchesCondition(1, 1), true);
  assert.equal(mr.matchesCondition('a', 'b'), false);
});

test('matchesCondition: array membership', () => {
  assert.equal(mr.matchesCondition('a', ['a', 'b']), true);
  assert.equal(mr.matchesCondition('c', ['a', 'b']), false);
});

test('matchesCondition: operator object', () => {
  assert.equal(mr.matchesCondition(5, { gte: 3 }), true);
  assert.equal(mr.matchesCondition(5, { lt: 3 }), false);
  assert.equal(mr.matchesCondition('hello', { regex: '^hel', flags: 'i' }), true);
  assert.equal(mr.matchesCondition('a', { in: ['a', 'b'] }), true);
  assert.equal(mr.matchesCondition('a', { notIn: ['a'] }), false);
});

test('matchesCondition: date range', () => {
  assert.equal(mr.matchesDateRange('2024-03-15', { from: '2024-01-01', to: '2024-12-31' }), true);
  assert.equal(mr.matchesDateRange('2023-12-31', { from: '2024-01-01' }), false);
  assert.equal(mr.matchesDateRange('not-a-date', {}), false);
});

test('matchesCondition: tags any / all', () => {
  assert.equal(mr.matchesTagSet(['a', 'b'], ['a'], 'any'), true);
  assert.equal(mr.matchesTagSet(['a', 'b'], ['c'], 'any'), false);
  assert.equal(mr.matchesTagSet(['a', 'b'], ['a', 'b'], 'all'), true);
  assert.equal(mr.matchesTagSet(['a'], ['a', 'b'], 'all'), false);
});

// ─── applyMetadataFilter ─────────────────────────────────────────────────

test('applyMetadataFilter: filters by single metadata key', () => {
  const passages = [
    { source: 'a', metadata: { section: 'intro' } },
    { source: 'b', metadata: { section: 'methods' } },
    { source: 'c', metadata: { section: 'intro' } },
  ];
  const r = mr.applyMetadataFilter({ passages, filter: { section: 'intro' } });
  assert.equal(r.kept.length, 2);
  assert.deepEqual(r.kept.map(k => k.source).sort(), ['a', 'c']);
});

test('applyMetadataFilter: combines multiple keys (AND semantics)', () => {
  const passages = [
    { source: 'a', metadata: { section: 'intro', year: 2024 } },
    { source: 'b', metadata: { section: 'intro', year: 2020 } },
    { source: 'c', metadata: { section: 'methods', year: 2024 } },
  ];
  const r = mr.applyMetadataFilter({
    passages, filter: { section: 'intro', year: { gte: 2022 } },
  });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].source, 'a');
});

test('applyMetadataFilter: missing key dropped by default, kept when flag set', () => {
  const passages = [
    { source: 'a', metadata: { section: 'intro' } },
    { source: 'b', metadata: {} }, // no section key
  ];
  const strict = mr.applyMetadataFilter({ passages, filter: { section: 'intro' } });
  assert.equal(strict.kept.length, 1);
  const lenient = mr.applyMetadataFilter({ passages, filter: { section: 'intro' }, keepMissing: true });
  assert.equal(lenient.kept.length, 2);
});

test('applyMetadataFilter: tagsAny', () => {
  const passages = [
    { source: 'a', metadata: { tags: ['legal', 'urgent'] } },
    { source: 'b', metadata: { tags: ['casual'] } },
  ];
  const r = mr.applyMetadataFilter({ passages, filter: { tags: { tagsAny: ['legal', 'finance'] } } });
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].source, 'a');
});

test('applyMetadataFilter: empty filter returns all passages', () => {
  const passages = [{ source: 'a' }, { source: 'b' }];
  const r = mr.applyMetadataFilter({ passages, filter: {} });
  assert.equal(r.kept.length, 2);
});

// ─── keywordRoute ────────────────────────────────────────────────────────

test('keywordRoute: picks collection with highest term overlap', () => {
  const collections = [
    { name: 'legal', description: 'contracts, compliance, lawsuits, regulations' },
    { name: 'finance', description: 'accounting, tax, payroll, invoices' },
    { name: 'hr', description: 'hiring, benefits, performance reviews' },
  ];
  const r = mr.keywordRoute({ query: 'I need help with a tax invoice', collections });
  assert.equal(r.top, 'finance');
  assert.equal(r.ranking.length, 3);
});

// ─── route (LLM with fallback) ───────────────────────────────────────────

test('route: LLM ranking canonicalised + shouldRetrieve = topK', async () => {
  const openai = scripted([
    JSON.stringify({
      ranking: [
        { name: 'finance', score: 0.9, reason: 'tax & invoices' },
        { name: 'legal', score: 0.2, reason: '' },
        { name: 'hr', score: 0.1, reason: '' },
      ],
      top: 'finance',
    }),
  ]);
  const collections = [
    { name: 'legal', description: '' },
    { name: 'finance', description: '' },
    { name: 'hr', description: '' },
  ];
  const r = await mr.route({ openai, query: 'tax invoice', collections, topK: 2 });
  assert.equal(r.source, 'llm');
  assert.equal(r.top, 'finance');
  assert.deepEqual(r.shouldRetrieve, ['finance', 'legal']);
});

test('route: LLM omits a collection → filled with zero score', async () => {
  const openai = scripted([
    JSON.stringify({
      ranking: [{ name: 'finance', score: 0.9, reason: '' }],
      top: 'finance',
    }),
  ]);
  const collections = [
    { name: 'finance', description: '' },
    { name: 'legal', description: '' },
  ];
  const r = await mr.route({ openai, query: 'q', collections });
  assert.equal(r.ranking.length, 2);
  const legal = r.ranking.find(x => x.name === 'legal');
  assert.equal(legal.score, 0);
  assert.equal(legal.reason, 'not ranked');
});

test('route: LLM error → keyword fallback', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('rate limited'); } } },
  };
  const collections = [
    { name: 'finance', description: 'tax and payroll' },
    { name: 'legal', description: 'contracts' },
  ];
  const r = await mr.route({ openai, query: 'tax and payroll', collections });
  assert.equal(r.source, 'keyword');
  assert.equal(r.top, 'finance');
});

test('route: null openai → keyword fallback without calling', async () => {
  const collections = [
    { name: 'a', description: 'alpha beta' },
    { name: 'b', description: 'gamma delta' },
  ];
  const r = await mr.route({ openai: null, query: 'gamma', collections });
  assert.equal(r.source, 'keyword');
  assert.equal(r.top, 'b');
});

test('route: empty collections list', async () => {
  const r = await mr.route({ openai: scripted([]), query: 'q', collections: [] });
  assert.equal(r.source, 'empty');
  assert.deepEqual(r.shouldRetrieve, []);
});
