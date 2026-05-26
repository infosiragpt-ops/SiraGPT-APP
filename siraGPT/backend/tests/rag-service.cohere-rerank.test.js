/**
 * Tests for the Cohere Rerank wire-up in rag-service.retrieve.
 *
 * We stub OpenAI embeddings (so the test is offline) and ALSO inject a
 * fake global fetch that the cohere-rerank module uses. Then we ingest
 * a few docs, call retrieve() with useCohereRerank=true, and assert the
 * pool order matches Cohere's relevance_score ranking.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
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
          data: input.map((text) => ({ embedding: Array.from(fakeVectorFor(text)) })),
        }),
      };
    }
  },
};

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key-for-tests';

const rag = require('../src/services/rag-service');

function withEnv(temp, fn) {
  const saved = {};
  for (const k of Object.keys(temp)) {
    saved[k] = process.env[k];
    if (temp[k] === undefined) delete process.env[k];
    else process.env[k] = temp[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('retrieve with useCohereRerank reorders the pool by Cohere score', async () => {
  await withEnv({ COHERE_API_KEY: 'co-test' }, async () => {
    const savedFetch = globalThis.fetch;
    // The fake Cohere endpoint always ranks the document whose text
    // contains the literal word 'keywords' as the top match, and
    // distributes descending scores to the rest. This makes the test
    // independent of whatever cosine order the fake embeddings produced.
    let lastSeenDocs = null;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      lastSeenDocs = body.documents;
      const results = body.documents
        .map((text, index) => ({
          index,
          relevance_score: text.includes('keywords') ? 0.97 : (text.includes('partial') ? 0.42 : 0.11),
        }))
        .sort((a, b) => b.relevance_score - a.relevance_score);
      return {
        ok: true,
        status: 200,
        json: async () => ({ results }),
        text: async () => '',
      };
    };
    try {
      const uid = `cohere-${Math.random()}`;
      const col = 'cohere-test';
      await rag.clear(uid, col);
      await rag.ingest(uid, col, [
        { text: 'doc zero: plain prose', title: 'A' },
        { text: 'doc one: matches the query keywords', title: 'B' },
        { text: 'doc two: partial match', title: 'C' },
      ], { size: 200, overlap: 0 });

      const hits = await rag.retrieve(uid, col, 'matches the query keywords', 3, {
        useCohereRerank: true,
      });
      assert.equal(hits.length, 3);
      // Cohere should have seen all three docs.
      assert.equal(lastSeenDocs.length, 3);
      // Top hit must be the doc Cohere ranked highest (contains 'keywords').
      // formatRetrievalHit strips rerankScore (it surfaces only in
      // diagnostics) but cohereScore is preserved on the hit envelope.
      assert.equal(hits[0].title, 'B', `expected B on top, got ${hits.map((h) => h.title)}`);
      assert.ok(hits[0].cohereScore >= 0.9, `expected cohereScore >= 0.9, got ${hits[0].cohereScore}`);
      // Subsequent hits are in descending Cohere-score order.
      for (let i = 1; i < hits.length; i++) {
        assert.ok(hits[i - 1].cohereScore >= hits[i].cohereScore);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test('retrieve gracefully falls back to prior ranking when Cohere fetch fails', async () => {
  await withEnv({ COHERE_API_KEY: 'co-test' }, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
    try {
      const uid = `cohere-fail-${Math.random()}`;
      const col = 'cohere-fail';
      await rag.clear(uid, col);
      await rag.ingest(uid, col, [
        { text: 'first doc with the query terms', title: 'first' },
        { text: 'second doc, different topic', title: 'second' },
      ], { size: 200, overlap: 0 });

      const hits = await rag.retrieve(uid, col, 'query terms', 2, {
        useCohereRerank: true,
      });
      // No crash; pool still ordered by the prior cosine path.
      assert.equal(hits.length, 2);
      // None of the entries should carry a Cohere score because the
      // rerank step bailed before assigning one.
      for (const h of hits) assert.equal(h.cohereScore, undefined);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

test('retrieve without useCohereRerank does not touch fetch at all', async () => {
  await withEnv({ COHERE_API_KEY: 'co-test' }, async () => {
    let fetchHit = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetchHit = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
    try {
      const uid = `cohere-off-${Math.random()}`;
      const col = 'cohere-off';
      await rag.clear(uid, col);
      await rag.ingest(uid, col, [{ text: 'plain doc' }], { size: 200, overlap: 0 });
      await rag.retrieve(uid, col, 'query', 1);  // no useCohereRerank
      assert.equal(fetchHit, false, 'Cohere fetch must not run when the flag is off');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
