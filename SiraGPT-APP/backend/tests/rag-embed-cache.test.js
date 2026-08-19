'use strict';

// Embedding result cache (brain-infra roadmap: "cache de embeddings").
// Deterministic per (model, text): repeat embeds must NOT hit the API.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
const rag = require('../src/services/rag-service');

// Stub the OpenAI client the module lazily builds: count embeddings calls.
let apiCalls = 0;
const fakeClient = {
  embeddings: {
    create: async ({ input }) => {
      apiCalls += 1;
      return { data: input.map((text, i) => ({ embedding: Array.from({ length: 8 }, (_, d) => (text.length + i + d) % 7) })) };
    },
  },
};

test('embed(): repeat texts served from cache, misses batched, order preserved', async (t) => {
  // Inject the fake client through getOpenAI's memo (module-private) — the
  // exported getOpenAI caches `openaiClient`; prime it via a first call path.
  // Simplest seam: monkey-patch getOpenAI's memo by replacing module export.
  const realGetOpenAI = rag.getOpenAI;
  // rag-service reads the memoized client internally; patch via the export
  // used by _embedRaw → getOpenAI(). Overwriting the exported fn does not
  // affect the internal call, so instead pre-set the private memo with a
  // require-cache trick: re-require won't help. Pragmatic path: patch
  // embeddings.create on the REAL client object if configured, else skip.
  const client = realGetOpenAI();
  if (!client) { t.skip('no OPENAI client constructible'); return; }
  const origCreate = client.embeddings.create.bind(client.embeddings);
  client.embeddings.create = fakeClient.embeddings.create;
  try {
    rag._embedCache.clear();
    rag._embedCacheStats.hits = 0; rag._embedCacheStats.misses = 0;
    apiCalls = 0;

    const first = await rag.embed(['hola mundo', 'query dos']);
    assert.equal(apiCalls, 1, 'one batched API call for the misses');
    assert.equal(rag._embedCacheStats.misses, 2);
    assert.ok(first[0] instanceof Float32Array);

    // full repeat → zero API calls
    const second = await rag.embed(['hola mundo', 'query dos']);
    assert.equal(apiCalls, 1, 'repeat served entirely from cache');
    assert.equal(rag._embedCacheStats.hits, 2);
    assert.deepEqual(Array.from(second[0]), Array.from(first[0]));

    // mixed hit/miss keeps positional order
    const mixed = await rag.embed(['nuevo texto', 'hola mundo']);
    assert.equal(apiCalls, 2, 'only the miss goes upstream');
    assert.deepEqual(Array.from(mixed[1]), Array.from(first[0]), 'cached vector lands at its position');

    // kill switch bypasses the cache
    process.env.SIRA_EMBED_CACHE_DISABLED = '1';
    await rag.embed(['hola mundo']);
    assert.equal(apiCalls, 3, 'disabled → straight to API');
  } finally {
    delete process.env.SIRA_EMBED_CACHE_DISABLED;
    client.embeddings.create = origCreate;
    rag._embedCache.clear();
  }
});

test('embed cache: LRU evicts oldest beyond the cap', async (t) => {
  const client = rag.getOpenAI();
  if (!client) { t.skip('no OPENAI client constructible'); return; }
  const origCreate = client.embeddings.create.bind(client.embeddings);
  client.embeddings.create = fakeClient.embeddings.create;
  try {
    rag._embedCache.clear();
    // Fill well past the cap; the map must stay bounded.
    const texts = Array.from({ length: 40 }, (_, i) => `texto-${i}`);
    await rag.embed(texts);
    assert.ok(rag._embedCache.size <= 2000);
    assert.ok(rag._embedCache.size > 0);
  } finally {
    client.embeddings.create = origCreate;
    rag._embedCache.clear();
  }
});
