/**
 * Regression test for the embed()-length guard in rag-service.ingest().
 *
 * Bug: if the embedding provider returns FEWER vectors than chunks (a partial
 * OpenAI response), the later chunks were stored with `embedding: undefined`,
 * which corrupts every future retrieval (cosine over undefined). The guard now
 * throws on a length mismatch so the caller marks indexing as failed/retries
 * instead of silently persisting broken chunks.
 *
 * Offline: the `openai` module is stubbed BEFORE requiring rag-service.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// A fake client whose embeddings.create can be told to DROP some outputs,
// simulating a partial provider response.
let dropLastN = 0;
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => {
          const vectors = input.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] }));
          // Simulate a partial response by returning fewer than requested.
          const kept = dropLastN > 0 ? vectors.slice(0, Math.max(0, vectors.length - dropLastN)) : vectors;
          return { data: kept };
        },
      };
    }
  },
};

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key-for-tests';

const rag = require('../src/services/rag-service');

test('ingest throws when embed() returns fewer vectors than chunks (no silent undefined embeddings)', async () => {
  const uid = `embedguard-${Math.random()}`;
  const col = 'guard';
  await rag.clear(uid, col);

  dropLastN = 1; // provider returns one fewer vector than inputs
  await assert.rejects(
    () => rag.ingest(uid, col, [
      { text: 'chunk uno con suficiente contenido para indexar.' },
      { text: 'chunk dos con suficiente contenido para indexar.' },
    ]),
    /embed returned .* vectors for .* chunk/i,
    'a partial embed response must throw, not store broken chunks',
  );

  // Nothing should have been persisted with a broken embedding.
  const hits = await rag.retrieve(uid, col, 'contenido', 3).catch(() => []);
  assert.equal(hits.length, 0, 'no chunks should be retrievable after the failed ingest');
});

test('ingest succeeds when embed() returns exactly one vector per chunk (guard does not false-fire)', async () => {
  const uid = `embedguard-ok-${Math.random()}`;
  const col = 'guard-ok';
  await rag.clear(uid, col);

  dropLastN = 0; // healthy: one vector per input
  const out = await rag.ingest(uid, col, [
    { text: 'chunk uno con suficiente contenido para indexar.' },
    { text: 'chunk dos con suficiente contenido para indexar.' },
  ]);
  assert.ok(out && out.chunksAdded >= 1, 'healthy ingest still works');
});
