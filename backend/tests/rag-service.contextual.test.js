/**
 * Tests for the Contextual Retrieval wire-up in rag-service.ingest.
 *
 * Same monkey-patch trick as rag-service.hybrid.test.js: stub OpenAI
 * embeddings BEFORE require()-ing rag-service. We additionally pass a
 * fake Anthropic client through opts.anthropic so we can verify the
 * contextual branch end-to-end without hitting either provider.
 *
 * Coverage:
 *   - ingest() with useContextualChunking embeds the CONTEXTUALIZED
 *     string (not the original chunk) and stores it under `text`
 *   - The legacy path (no opts.useContextualChunking) is unchanged
 *   - Failures bubble up via result.contextualFailures without
 *     poisoning the rest of the batch
 *   - Token usage from the contextualizer is summed into result.contextualUsage
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

const embedCalls = [];
require.cache[require.resolve('openai')] = {
  exports: class FakeOpenAI {
    constructor() {
      this.embeddings = {
        create: async ({ input }) => {
          embedCalls.push(input.slice());
          return { data: input.map((text) => ({ embedding: Array.from(fakeVectorFor(text)) })) };
        },
      };
    }
  },
};

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key-for-tests';

const rag = require('../src/services/rag-service');

function fakeAnthropic({ contextFn } = {}) {
  const calls = [];
  const client = {
    messages: {
      create: async (req) => {
        calls.push(req);
        const userText = req.messages?.[0]?.content || '';
        const ctxText = typeof contextFn === 'function' ? contextFn(userText, calls.length - 1) : `CTX-${calls.length}`;
        return {
          content: [{ type: 'text', text: ctxText }],
          usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: calls.length === 1 ? 0 : 200, cache_creation_input_tokens: calls.length === 1 ? 200 : 0 },
        };
      },
    },
  };
  client.__calls = calls;
  return client;
}

test('ingest with useContextualChunking embeds the contextualized text and stores it under text', async () => {
  const uid = `test-ctx-${Math.random()}`;
  const col = 'ctx-test';
  await rag.clear(uid, col);

  embedCalls.length = 0;
  const anthropic = fakeAnthropic({ contextFn: (_user, i) => `Section about clima ${i}` });
  const docBody = 'Body about clima en CDMX 2026. '.repeat(50);

  const result = await rag.ingest(uid, col, [{ text: docBody, source: 'cdmx', title: 'Clima' }], {
    useContextualChunking: true,
    anthropic,
    size: 200,
    overlap: 0,
  });

  assert.equal(result.contextualized, true);
  assert.ok(result.chunksAdded > 0, 'should have ingested chunks');
  // Each chunk got one Anthropic call.
  assert.equal(anthropic.__calls.length, result.chunksAdded);

  // The embed() call must have received the CONTEXTUALIZED strings.
  // The ingest path may split the embed batch internally — flatten and
  // assert on every input text rather than pinning the call count.
  assert.ok(embedCalls.length >= 1, 'at least one embed batch');
  const allEmbeddedTexts = embedCalls.flat();
  assert.ok(allEmbeddedTexts.length === result.chunksAdded, 'one embed input per chunk');
  for (const text of allEmbeddedTexts) {
    assert.ok(text.startsWith('Section about clima '), `expected context prefix, got: ${text.slice(0, 50)}…`);
  }

  // Retrieve to confirm the stored `text` is the contextualized form
  // (so downstream consumers see the prefix that helps the LLM).
  const hits = await rag.retrieve(uid, col, 'clima en CDMX', 1);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.startsWith('Section about clima '));
});

test('ingest WITHOUT useContextualChunking is unchanged (no Anthropic call, embed sees originals)', async () => {
  const uid = `test-noctx-${Math.random()}`;
  const col = 'noctx-test';
  await rag.clear(uid, col);

  embedCalls.length = 0;
  const anthropic = fakeAnthropic();
  await rag.ingest(uid, col, [{ text: 'plain body about widgets', title: 'Widgets' }], {
    size: 200,
    overlap: 0,
    // useContextualChunking deliberately omitted
    anthropic,
  });
  assert.equal(anthropic.__calls.length, 0, 'no contextualizer call when flag is off');
  assert.equal(embedCalls.length, 1);
  for (const text of embedCalls[0]) {
    assert.ok(!text.startsWith('CTX-'), 'embed should see ORIGINAL chunk text');
  }
});

test('ingest tolerates per-chunk contextualizer failures and fills original text', async () => {
  const uid = `test-fail-${Math.random()}`;
  const col = 'fail-test';
  await rag.clear(uid, col);

  embedCalls.length = 0;
  // Throw on the second chunk, succeed on the others.
  const anthropic = (() => {
    const client = fakeAnthropic({ contextFn: (_u, i) => `CTX-${i}` });
    const orig = client.messages.create;
    let n = 0;
    client.messages.create = async (req) => {
      n += 1;
      if (n === 2) throw new Error('429 throttled');
      return orig(req);
    };
    return client;
  })();

  const docBody = 'Sentence one. Sentence two. Sentence three. '.repeat(20);
  const result = await rag.ingest(uid, col, [{ text: docBody }], {
    useContextualChunking: true,
    anthropic,
    size: 100,
    overlap: 0,
    contextualOptions: { concurrency: 1 }, // serialise so 'second chunk' is deterministic
  });

  assert.equal(result.contextualized, true);
  assert.ok(result.contextualFailures.length >= 1, 'one failure expected');
  // Embedded inputs include at least one entry that's NOT prefixed
  // (the failed chunk fell back to the original text).
  const embeddedTexts = embedCalls.flat();
  const fallbacks = embeddedTexts.filter((t) => !/^CTX-\d/.test(t));
  assert.ok(fallbacks.length >= 1, 'at least one chunk fell back to original');
});

test('ingest accumulates contextualizer token usage into result.contextualUsage', async () => {
  const uid = `test-usage-${Math.random()}`;
  const col = 'usage-test';
  await rag.clear(uid, col);

  const anthropic = fakeAnthropic();
  const docBody = 'usage chunk. '.repeat(40);
  const result = await rag.ingest(uid, col, [{ text: docBody }], {
    useContextualChunking: true,
    anthropic,
    size: 80,
    overlap: 0,
    contextualOptions: { concurrency: 1 },
  });

  assert.ok(result.contextualUsage.input_tokens > 0);
  assert.ok(result.contextualUsage.output_tokens > 0);
  // First call writes the cache; subsequent calls read it.
  assert.ok(result.contextualUsage.cache_creation_input_tokens > 0);
  assert.ok(result.contextualUsage.cache_read_input_tokens >= 0);
});
