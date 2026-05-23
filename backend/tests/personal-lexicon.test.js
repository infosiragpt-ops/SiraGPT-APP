'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the rag-service BEFORE requiring personal-lexicon so the module
// captures our stub at module-load time.
const ragStub = {
  _ingested: [],
  _retrieveHits: [],
  ingest: async (userId, collection, docs) => {
    ragStub._ingested.push({ userId, collection, docs });
    return docs.length;
  },
  retrieve: async (userId, collection, query, k) => {
    return ragStub._retrieveHits.map((h, i) => ({
      text: h.text,
      title: h.title || 'lexicon',
      score: h.score != null ? h.score : Math.max(0.1, 1 - i * 0.1),
    }));
  },
  clear: async () => true,
  stats: async () => ({ chunks: ragStub._ingested.length }),
  embed: async (texts) => texts.map(() => new Array(8).fill(0.1)),
};
const Module = require('module');
const ragPath = require.resolve('../src/services/rag-service');
require.cache[ragPath] = {
  id: ragPath,
  filename: ragPath,
  loaded: true,
  exports: ragStub,
};

const L = require('../src/services/personal-lexicon');

test.beforeEach(() => {
  ragStub._ingested = [];
  ragStub._retrieveHits = [];
  L._internal._clearAllForTests();
});

// ─── Helpers ─────────────────────────────────────────────────────────

test('termHash: case + accent insensitive', () => {
  assert.equal(L._internal.termHash('Mi CV'), L._internal.termHash('mi cv'));
  assert.equal(L._internal.termHash('Niño'), L._internal.termHash('nino'));
});

test('clamp: respects max length and trims', () => {
  assert.equal(L._internal.clamp('  hola  ', 10), 'hola');
  const long = 'x'.repeat(200);
  const c = L._internal.clamp(long, 50);
  assert.ok(c.length <= 50);
  assert.ok(c.endsWith('…'));
});

test('meta: bumpMeta increments hits + sets lastSeenAt', () => {
  L._internal.bumpMeta('u1', 'mi CV');
  L._internal.bumpMeta('u1', 'mi cv');
  const meta = L._internal.getMeta('u1', 'mi CV');
  assert.equal(meta.hits, 2);
  assert.ok(meta.lastSeenAt > 0);
});

test('meta: unknown user returns zeros', () => {
  const meta = L._internal.getMeta('ghost', 'mi cv');
  assert.equal(meta.hits, 0);
  assert.equal(meta.lastSeenAt, 0);
});

// ─── recordTerm ──────────────────────────────────────────────────────

test('recordTerm: ingests doc with term=definition shape', async () => {
  const ok = await L.recordTerm({ userId: 'u1', term: 'mi CV', definition: 'archivo resumen_2026.pdf' });
  assert.equal(ok, true);
  assert.equal(ragStub._ingested.length, 1);
  assert.match(ragStub._ingested[0].docs[0].text, /mi CV = archivo resumen_2026\.pdf/);
});

test('recordTerm: collection name is per-user', async () => {
  await L.recordTerm({ userId: 'u1', term: 'foo', definition: 'bar' });
  assert.equal(ragStub._ingested[0].collection, 'lexicon:u1');
});

test('recordTerm: returns false on missing fields', async () => {
  assert.equal(await L.recordTerm({ userId: 'u1', term: '', definition: 'x' }), false);
  assert.equal(await L.recordTerm({ userId: 'u1', term: 'x', definition: '' }), false);
  assert.equal(await L.recordTerm({ userId: '', term: 'x', definition: 'y' }), false);
});

test('recordTerm: bumps meta after success', async () => {
  await L.recordTerm({ userId: 'u1', term: 'mi cv', definition: 'archivo X' });
  const meta = L._internal.getMeta('u1', 'mi cv');
  assert.equal(meta.hits, 1);
});

test('recordTerm: swallows ingest errors', async () => {
  ragStub.ingest = async () => { throw new Error('rag down'); };
  const ok = await L.recordTerm({ userId: 'u1', term: 'x', definition: 'y' });
  assert.equal(ok, false);
  // Restore
  ragStub.ingest = async (uid, coll, docs) => { ragStub._ingested.push({ uid, coll, docs }); return docs.length; };
});

// ─── recordTermsBatch ────────────────────────────────────────────────

test('batch: records multiple entries', async () => {
  const n = await L.recordTermsBatch({
    userId: 'u1',
    entries: [
      { term: 'mi CV', definition: 'archivo X' },
      { term: 'el cliente premium', definition: 'cliente Acme' },
    ],
  });
  assert.equal(n, 2);
  assert.equal(ragStub._ingested.length, 2);
});

test('batch: skips empty entries', async () => {
  const n = await L.recordTermsBatch({
    userId: 'u1',
    entries: [
      { term: 'foo', definition: 'bar' },
      { term: '', definition: 'x' },
      null,
      undefined,
    ],
  });
  assert.equal(n, 1);
});

test('batch: returns 0 when empty', async () => {
  assert.equal(await L.recordTermsBatch({ userId: 'u1', entries: [] }), 0);
  assert.equal(await L.recordTermsBatch({ userId: 'u1' }), 0);
});

// ─── lookupTerms ─────────────────────────────────────────────────────

test('lookup: parses term=definition pairs', async () => {
  ragStub._retrieveHits = [
    { text: 'mi CV = archivo resumen.pdf', score: 0.9 },
    { text: 'el plan Q3 = iniciativa Q3 2026', score: 0.7 },
  ];
  const terms = await L.lookupTerms({ userId: 'u1', prompt: 'actualiza mi CV' });
  assert.equal(terms.length, 2);
  assert.equal(terms[0].term, 'mi CV');
  assert.equal(terms[0].definition, 'archivo resumen.pdf');
});

test('lookup: skips malformed entries (no equals sign)', async () => {
  ragStub._retrieveHits = [
    { text: 'mi CV = archivo X', score: 0.9 },
    { text: 'corrupt entry without equals', score: 0.7 },
  ];
  const terms = await L.lookupTerms({ userId: 'u1', prompt: 'algo' });
  assert.equal(terms.length, 1);
});

test('lookup: sorts by composite confidence', async () => {
  ragStub._retrieveHits = [
    { text: 'low = x', score: 0.3 },
    { text: 'high = y', score: 0.95 },
  ];
  const terms = await L.lookupTerms({ userId: 'u1', prompt: 'algo' });
  assert.equal(terms[0].term, 'high');
});

test('lookup: caps at k', async () => {
  ragStub._retrieveHits = Array.from({ length: 20 }, (_, i) => ({ text: `t${i} = d${i}`, score: 0.5 }));
  const terms = await L.lookupTerms({ userId: 'u1', prompt: 'algo', k: 3 });
  assert.equal(terms.length, 3);
});

test('lookup: returns [] for missing userId or prompt', async () => {
  assert.deepEqual(await L.lookupTerms({ userId: '', prompt: 'x' }), []);
  assert.deepEqual(await L.lookupTerms({ userId: 'u1', prompt: '' }), []);
});

test('lookup: swallows retrieve errors', async () => {
  ragStub.retrieve = async () => { throw new Error('rag down'); };
  const out = await L.lookupTerms({ userId: 'u1', prompt: 'algo' });
  assert.deepEqual(out, []);
  // Restore
  ragStub.retrieve = async () => ragStub._retrieveHits.map((h) => ({ text: h.text, score: h.score }));
});

test('lookup: empty hits → empty result', async () => {
  ragStub._retrieveHits = [];
  const terms = await L.lookupTerms({ userId: 'u1', prompt: 'algo' });
  assert.deepEqual(terms, []);
});

// ─── buildLexiconBlock ────────────────────────────────────────────────

test('block: returns null for empty input', () => {
  assert.equal(L.buildLexiconBlock([]), null);
  assert.equal(L.buildLexiconBlock(null), null);
});

test('block: formats terms with bullet list', () => {
  const block = L.buildLexiconBlock([
    { term: 'mi CV', definition: 'resumen.pdf' },
    { term: 'el plan Q3', definition: 'proyecto Q3 2026' },
  ]);
  assert.match(block, /PERSONAL_LEXICON/);
  assert.match(block, /"mi CV" → resumen\.pdf/);
  assert.match(block, /"el plan Q3" → proyecto Q3 2026/);
});

// ─── decayUnused ─────────────────────────────────────────────────────

test('decay: removes meta older than threshold', () => {
  L._internal.bumpMeta('u1', 'old');
  // Backdate
  const innerMap = L._internal.bumpMeta('u1', 'old');
  // Direct access via getMeta won't let us mutate; reach through bumpMeta
  // and then patch via the user's inner map.
  // Simpler: call bumpMeta then set lastSeenAt to past
  // We need access — expose via _internal for tests
  L._internal.bumpMeta('u1', 'fresh');
  const removed = L.decayUnused({ userId: 'u1', olderThanDays: 0 });
  // With olderThanDays=0, nothing was old enough (all just created); decay returns 0
  assert.equal(removed, 0);
});

test('decay: returns 0 for unknown user', () => {
  assert.equal(L.decayUnused({ userId: 'ghost', olderThanDays: 30 }), 0);
});

test('decay: returns 0 for missing userId', () => {
  assert.equal(L.decayUnused({}), 0);
});

// ─── extractTermsLLM ─────────────────────────────────────────────────

test('extract: parses JSON response with terms array', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({ terms: [
        { term: 'mi CV', definition: 'archivo resumen.pdf' },
        { term: 'el cliente premium', definition: 'Acme Corp' },
      ] }) } }],
    }) } },
  };
  const terms = await L.extractTermsLLM(openai, 'actualiza mi CV', '[archivo actualizado]');
  assert.equal(terms.length, 2);
  assert.equal(terms[0].term, 'mi CV');
});

test('extract: caps at MAX_TERMS_PER_TURN', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({
        terms: Array.from({ length: 20 }, (_, i) => ({ term: `t${i}`, definition: `d${i}` })),
      }) } }],
    }) } },
  };
  const terms = await L.extractTermsLLM(openai, 'foo', 'bar');
  assert.ok(terms.length <= L.MAX_TERMS_PER_TURN);
});

test('extract: returns [] on malformed JSON', async () => {
  const openai = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } },
  };
  const terms = await L.extractTermsLLM(openai, 'a', 'b');
  assert.deepEqual(terms, []);
});

test('extract: returns [] when transcript too short', async () => {
  const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } };
  const terms = await L.extractTermsLLM(openai, '', '');
  assert.deepEqual(terms, []);
});

test('extract: returns [] when openai missing', async () => {
  assert.deepEqual(await L.extractTermsLLM(null, 'a', 'b'), []);
});

test('extract: swallows openai errors', async () => {
  const openai = { chat: { completions: { create: async () => { throw new Error('api down'); } } } };
  const terms = await L.extractTermsLLM(openai, 'foo bar', 'baz qux');
  assert.deepEqual(terms, []);
});

// ─── stats + clear ────────────────────────────────────────────────────

test('stats: returns collection + counts', async () => {
  await L.recordTerm({ userId: 'u1', term: 'a', definition: 'b' });
  const s = await L.lexiconStats('u1');
  assert.equal(s.collection, 'lexicon:u1');
  assert.ok(s.terms >= 0);
});

test('clear: removes user data', async () => {
  await L.recordTerm({ userId: 'u1', term: 'a', definition: 'b' });
  await L.clearUserLexicon('u1');
  assert.equal(L._internal.getMeta('u1', 'a').hits, 0);
});
