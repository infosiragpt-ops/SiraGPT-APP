/**
 * Integration-ish test for the hybrid retrieval path in rag-service.
 *
 * We stub embedding + OpenAI so the test is offline. The point is to
 * verify RRF actually fuses the two rankings — a doc that both rankers
 * rank top should beat a doc only one ranker favours.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Monkey-patch the rag-service's embed() by overriding the OpenAI module
// *before* requiring rag-service. We replace `embeddings.create` to
// return deterministic unit vectors derived from the text — same text
// → same vector, so cosine is 1 for identical strings.
const path = require('path');

function fakeVectorFor(text) {
  // 8-dim "embedding" that hashes the token bag into slots. Deterministic
  // across equal strings but not too similar across different strings.
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  // L2-normalise so cosine is well-defined.
  let norm = 0;
  for (let i = 0; i < 8; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 8; i++) v[i] /= norm;
  return v;
}

require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => ({
          data: input.map(text => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key-for-tests';

const rag = require('../src/services/rag-service');

test('hybrid retrieval: doc matching BOTH keyword and semantic wins', async () => {
  const uid = `test-${Math.random()}`;
  const col = 'hybrid-test';
  await rag.clear(uid, col);

  await rag.ingest(uid, col, [
    { text: 'The pricing plan for enterprise customers starts at five thousand dollars monthly.' },
    { text: 'Enterprise billing includes custom invoicing and net-30 terms.' },
    { text: 'Refund policy covers purchases within thirty days of receipt.' },
    { text: 'Our API key rotation happens every 90 days automatically.' },
    { text: 'The pricing FAQ explains enterprise discounts and volume tiers.' },
  ]);

  // Query "enterprise pricing" — both "pricing" and "enterprise" are
  // lexical hits; doc #1 and #5 have both terms. In cosine-only mode
  // those should still rank highly, but hybrid should bump them further.
  const hits = await rag.retrieve(uid, col, 'enterprise pricing', 3, { useHybrid: true });
  assert.ok(hits.length > 0, 'hybrid returns at least one hit');

  const texts = hits.map(h => h.text);
  // At least one of the top hits must be one of the dual-keyword docs.
  const gotDualKeyword = texts.some(t => t.includes('enterprise') && t.includes('pricing'));
  assert.ok(gotDualKeyword, `expected enterprise+pricing doc in top 3, got:\n${texts.join('\n---\n')}`);
});

test('hybrid retrieval: returned hits do not leak internal fields', async () => {
  const uid = `test-${Math.random()}`;
  const col = 'hybrid-leak';
  await rag.clear(uid, col);

  await rag.ingest(uid, col, [
    { text: 'alpha beta gamma' },
    { text: 'beta gamma delta' },
  ]);

  const hits = await rag.retrieve(uid, col, 'gamma', 2, { useHybrid: true });
  for (const h of hits) {
    assert.ok(!('_idx' in h), '_idx should be stripped');
    assert.ok(!('semRank' in h), 'semRank should be stripped');
    assert.ok(!('bmRank' in h), 'bmRank should be stripped');
    assert.ok(!('fusedScore' in h), 'fusedScore should be stripped');
    assert.ok(!('diagnostics' in h), 'diagnostics should be opt-in');
  }
});

test('hybrid retrieval: trace exposes vector/text/fusion evidence when requested', async () => {
  const uid = `test-${Math.random()}`;
  const col = 'hybrid-trace';
  await rag.clear(uid, col);

  await rag.ingest(uid, col, [
    { text: 'DeepSeek V4 Flash supports fast reasoning and long context windows.' },
    { text: 'Gemini handles multimodal inputs and grounded responses.' },
    { text: 'The finance report contains pricing, margins and revenue metrics.' },
  ]);

  const result = await rag.retrieveWithTrace(uid, col, 'DeepSeek long reasoning', 2, {
    useHybrid: true,
    useExpansion: true,
  });

  assert.equal(result.trace.schema_version, 'sira.rag_retrieval_trace.v1');
  assert.equal(result.trace.mode, 'hybrid_rrf');
  assert.equal(result.trace.scoring.vector, true);
  assert.equal(result.trace.scoring.text, true);
  assert.ok(result.trace.candidates.total >= 3);
  assert.ok(result.hits.length > 0);
  assert.equal(result.hits[0].diagnostics.schema_version, 'sira.rag_hit_diagnostics.v1');
  assert.equal(typeof result.hits[0].diagnostics.vectorScore, 'number');
  assert.equal(typeof result.hits[0].diagnostics.textScore, 'number');
  assert.equal(typeof result.hits[0].diagnostics.fusionScore, 'number');
});

test('hybrid retrieval: trace is returned for empty collections', async () => {
  const uid = `test-${Math.random()}`;
  const result = await rag.retrieveWithTrace(uid, 'empty-trace', 'anything', 2, { useHybrid: true });

  assert.deepEqual(result.hits, []);
  assert.equal(result.trace.schema_version, 'sira.rag_retrieval_trace.v1');
  assert.equal(result.trace.returned_k, 0);
  assert.equal(result.trace.candidates.total, 0);
});

test('cosine-only path still works (regression guard)', async () => {
  const uid = `test-${Math.random()}`;
  const col = 'cosine-only';
  await rag.clear(uid, col);

  await rag.ingest(uid, col, [
    { text: 'cats are mammals' },
    { text: 'birds can fly' },
  ]);

  const hits = await rag.retrieve(uid, col, 'cats', 1);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes('cats'));
});

test('positiveIntEnv keeps the per-collection cap enabled for bad env values', () => {
  // Regression: a non-numeric SIRAGPT_RAG_MAX_CHUNKS parsed to NaN, and
  // `length > NaN` is always false — silently disabling the eviction cap.
  assert.equal(rag.positiveIntEnv('5000', 10000), 5000);
  assert.equal(rag.positiveIntEnv('abc', 10000), 10000, 'non-numeric → fallback, not NaN');
  assert.equal(rag.positiveIntEnv(undefined, 10000), 10000);
  assert.equal(rag.positiveIntEnv('', 10000), 10000);
  assert.equal(rag.positiveIntEnv('0', 10000), 10000, 'zero → fallback');
  assert.equal(rag.positiveIntEnv('-5', 10000), 10000, 'negative → fallback');
});
