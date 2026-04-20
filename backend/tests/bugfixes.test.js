/**
 * Regression tests for the audit/bug-fix round.
 *
 * Each test below maps to a bug that was shipped in a previous commit
 * and is now fixed. A failure here means the underlying regression
 * returned.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Stub openai before requiring services.
function fakeVectorFor(text) {
  const v = new Float32Array(8);
  const tokens = (text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 8;
    v[h] += 1;
  }
  let n = 0;
  for (let i = 0; i < 8; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i++) v[i] /= n;
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
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const codeChunker = require('../src/services/code-chunker');
const tripleGraph = require('../src/services/triple-graph');
const rag = require('../src/services/rag-service');
const reranker = require('../src/services/llm-reranker');
const core = require('../src/services/agents/agent-core');

// ─── BUG 1: code-chunker arrow-without-braces swallows unrelated code ──────
//
// The ternary `hasOpenBrace || hasArrow ? findBraceEnd(...) : i` used to
// walk findBraceEnd for arrow-without-braces, which scans forward until
// the next `{...}` block — which could be an UNRELATED function below.

test('codeChunker: `const f = x => x * 2;` is a one-line chunk, not a blob', () => {
  const src = `
const double = x => x * 2;

function unrelated() {
  return { big: 'block' };
}

const triple = y => y * 3;
`;
  const chunks = codeChunker.chunkCode('math.js', src);
  const doubleChunk = chunks.find(c => c.name === 'double');
  assert.ok(doubleChunk, 'double should be extracted');
  assert.ok(
    !doubleChunk.text.includes('unrelated'),
    `arrow-without-braces chunk leaked into unrelated function:\n${doubleChunk.text}`,
  );
  // The chunk should span a very small line range (1–3 lines).
  assert.ok(doubleChunk.endLine - doubleChunk.startLine <= 2,
    `expected ≤3-line chunk, got ${doubleChunk.startLine}-${doubleChunk.endLine}`);
});

test('codeChunker: arrow with explicit body `=> {` still uses brace-balance', () => {
  const src = `
const compute = (x) => {
  const a = x * 2;
  return a + 1;
};
`;
  const chunks = codeChunker.chunkCode('math.ts', src);
  const compute = chunks.find(c => c.name === 'compute');
  assert.ok(compute);
  assert.ok(compute.text.includes('return a + 1'));
});

test('codeChunker: detects `const f = async () =>` as async', () => {
  const src = `export const fetchUser = async (id) => {
  return await db.users.get(id);
};`;
  const chunks = codeChunker.chunkCode('x.ts', src);
  const fn = chunks.find(c => c.name === 'fetchUser');
  assert.ok(fn);
  assert.equal(fn.isAsync, true);
});

// ─── BUG 2: triple-graph embedding backfill ────────────────────────────────
//
// A triple inserted without an embedding could never receive one on a
// later ingest pass. This broke retrieval for setups that did heuristic
// ingestion first (no API key) and later re-indexed with the LLM.

test('tripleGraph: second addTriples with embedder backfills missing embeddings', async () => {
  const uid = `bf-${Math.random()}`;
  const col = 'bf-test';
  tripleGraph.clear(uid, col);

  // Step 1: insert without embeddings.
  await tripleGraph.addTriples(uid, col, [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
  ], { embedder: null });

  // The triple is indexed but has no embedding, so linkTriple can't find it.
  const linkedBefore = await tripleGraph.linkTriple(
    uid, col, { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
    { embedder: (texts) => Promise.resolve(texts.map(fakeVectorFor)) },
  );
  assert.equal(linkedBefore, null, 'before backfill: no embedded triples');

  // Step 2: re-ingest the same triple with an embedder — previously a no-op.
  const result = await tripleGraph.addTriples(uid, col, [
    { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
  ], { embedder: (texts) => Promise.resolve(texts.map(fakeVectorFor)) });

  // added==0 (no NEW triples), but embedded==1 (backfilled the existing one).
  assert.equal(result.added, 0, 'no new triple inserted');
  assert.equal(result.embedded, 1, 'existing triple was backfilled with an embedding');

  const linkedAfter = await tripleGraph.linkTriple(
    uid, col, { subject: 'Curry', predicate: 'plays for', object: 'Warriors' },
    { embedder: (texts) => Promise.resolve(texts.map(fakeVectorFor)) },
  );
  assert.ok(linkedAfter, 'after backfill: linkTriple should find it');
});

// ─── BUG 3: fuseByRRF identity collision on same-source first-40-char ─────
//
// Two distinct chunks with identical first 40 chars got merged under the
// old identity fallback. djb2 over full text prevents the collision.

test('fuseByRRF: chunks with same source + same first-40-chars kept distinct', () => {
  // Exactly 40 identical starting chars, diverging after.
  const prefix = 'Function handler receives the request and ';
  const a = { text: prefix + 'returns user data after validation.', source: 'h.js' };
  const b = { text: prefix + 'emits metrics then forwards to next.', source: 'h.js' };
  const fused = rag.fuseByRRF([a], [b], { k: 10 });
  assert.equal(fused.length, 2, 'distinct chunks must not collapse');
});

test('fuseByRRF: identical chunks DO merge (accumulate score)', () => {
  const same = { text: 'exactly identical content', source: 'x.js' };
  const fused = rag.fuseByRRF([same], [same], { k: 10 });
  assert.equal(fused.length, 1);
});

// ─── BUG 4: rag.retrieve hybrid path no longer O(n²) ──────────────────────
//
// We can't cleanly assert Big-O from a unit test, but we CAN verify the
// function still returns correct results when entries contain duplicates
// — the old `entries.indexOf(e)` collapsed duplicates silently.

test('rag.retrieve hybrid: preserves distinct chunks even when text matches', async () => {
  const uid = `hy-${Math.random()}`;
  const col = 'hy-dup';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'common fragment about pricing', source: 'a.md' },
    { text: 'common fragment about pricing', source: 'b.md' }, // same text, different source
  ]);
  const hits = await rag.retrieve(uid, col, 'pricing', 5, { useHybrid: true });
  // Old behaviour: `indexOf` returned 0 for both, collapsing b.md into a.md's slot.
  const sources = new Set(hits.map(h => h.source));
  assert.ok(sources.has('a.md') && sources.has('b.md'),
    'hybrid retrieve must preserve chunks from both sources');
});

// ─── BUG 5: llm-reranker silent tail drop ──────────────────────────────────
//
// Passing more candidates than maxChunksPerBatch used to drop the excess.
// Now the tail is preserved with the fallback score.

test('rerank: preserves candidates beyond maxChunksPerBatch', async () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    text: `doc ${i}`, score: 0.9 - i * 0.01,
  }));
  const stub = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                rankings: Array.from({ length: 20 }, (_, i) => ({
                  passage_number: i + 1, score: 1 - i * 0.05,
                })),
              }),
            },
          }],
        }),
      },
    },
  };
  reranker.clearCache();
  const out = await reranker.rerank(stub, 'q', candidates, { maxChunksPerBatch: 20 });
  // All 30 should come back (head of 20 reranked + tail of 10 with fallback).
  assert.equal(out.length, 30);
  // The tail entries keep their original position relative to each other.
  const tailTexts = out.slice(20).map(c => c.text);
  assert.deepEqual(tailTexts, candidates.slice(20).map(c => c.text));
});

test('rerank: fewer than maxChunksPerBatch works unchanged', async () => {
  const candidates = [
    { text: 'a', score: 0.3 },
    { text: 'b', score: 0.9 },
    { text: 'c', score: 0.5 },
  ];
  const out = await reranker.rerank(null, 'q', candidates);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, 'b'); // sorted by cosine
});

// ─── BUG 6: agent-core trace compaction ────────────────────────────────────

test('AgentTrace.toMessages: compacts older steps to summary length', () => {
  const tr = new core.AgentTrace();
  // Push 6 steps. The last 3 should be full, the first 3 summarised.
  const long = 'x'.repeat(3000);
  for (let i = 0; i < 6; i++) {
    tr.append({ think: `step ${i}`, tool: 'read_file', args: { source: `f${i}` }, observation: long });
  }
  const msgs = tr.toMessages();
  // Messages come as [assistant, user, assistant, user, ...].
  // First three observation messages (idx 1, 3, 5) should be summarised.
  const obs0 = msgs[1].content;
  const obs5 = msgs[11].content;
  assert.ok(
    obs0.length < obs5.length,
    `older observation should be shorter than recent:\nolder=${obs0.length} recent=${obs5.length}`,
  );
  assert.ok(obs0.includes('summarised'), 'old observation should be tagged summarised');
});

test('AgentTrace.toMessages: with <= RECENT_STEPS_FULL steps, all kept full', () => {
  const tr = new core.AgentTrace();
  const long = 'x'.repeat(3000);
  for (let i = 0; i < core.RECENT_STEPS_FULL; i++) {
    tr.append({ tool: 'read_file', args: { s: i }, observation: long });
  }
  const msgs = tr.toMessages();
  for (let i = 1; i < msgs.length; i += 2) {
    const obs = msgs[i].content;
    // Should contain most of the long string — not summarised.
    assert.ok(obs.length > 2000, `expected full observation, got ${obs.length}`);
  }
});

// ─── BUG 7: search_code no longer runs BM25 twice ─────────────────────────
//
// Hard to measure directly from a unit test, but we can assert the tool
// still returns sensible results — the semantic call path now uses
// cosine-only internally.

test('agent-tools.search_code: still returns identifier matches', async () => {
  const tools = require('../src/services/agents/agent-tools');
  const uid = `sc-${Math.random()}`;
  const col = 'sc-post';
  rag.clear(uid, col);
  await rag.ingest(uid, col, [
    { text: 'function createUser(email) { return { email }; }', source: 'a.js' },
    { text: 'function deleteUser(id) { return null; }', source: 'b.js' },
    { text: 'const config = { port: 3000 };', source: 'c.js' },
  ]);
  const out = await tools.search_code.handler(
    { query: 'createUser' },
    { userId: uid, collection: col },
  );
  assert.ok(out.hits.length > 0);
  assert.equal(out.hits[0].source, 'a.js');
});
