/**
 * Tests for Self-RAG / CRAG / FLARE orchestrators.
 *
 * We stub the retriever, generator, and LLM so the tests assert on
 * CONTROL FLOW (does Self-RAG skip retrieval on the gate's say-so,
 * does CRAG invoke external search on grade=incorrect, does FLARE
 * trigger retrieval on low confidence) rather than LLM quality.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const ap = require('../src/services/rag/advanced-patterns');

function scripted(seq) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      return { choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }] };
    }}},
  };
}

// ─── Self-RAG ────────────────────────────────────────────────────────────

test('self-rag: gate says skip → no retrieval, still generates', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: false, reason: 'general knowledge question' }),
  ]);
  let retrieveCalled = false;
  const retrieve = async () => { retrieveCalled = true; return []; };
  const generate = async ({ passages }) => `answered without retrieval; passages=${passages.length}`;
  const r = await ap.selfRag({ openai, query: 'what is 2+2?', retrieve, generate });
  assert.equal(retrieveCalled, false);
  assert.equal(r.usedRetrieval, false);
  assert.equal(r.answer, 'answered without retrieval; passages=0');
});

test('self-rag: gate says retrieve → passes grounded passages, drops low-grounding', async () => {
  const openai = scripted([
    JSON.stringify({ retrieve: true, reason: 'fact-heavy question' }),
    JSON.stringify({ relevance: 0.9, grounding: 0.8, utility: 0.8, reason: 'good' }),
    JSON.stringify({ relevance: 0.7, grounding: 0.2, utility: 0.3, reason: 'speculation' }),
    JSON.stringify({ relevance: 0.8, grounding: 0.7, utility: 0.7, reason: 'solid' }),
  ]);
  const retrieve = async () => [
    { source: 'a', text: 'A' },
    { source: 'b', text: 'B' },
    { source: 'c', text: 'C' },
  ];
  const generate = async ({ passages }) => `answer using ${passages.map(p => p.source).join(',')}`;
  const r = await ap.selfRag({ openai, query: 'fact q', retrieve, generate, minGrounding: 0.5 });
  assert.equal(r.usedRetrieval, true);
  assert.equal(r.kept.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].source, 'b');
  assert.match(r.answer, /a,c/);
});

test('self-rag: rater error → passage kept (fail-open)', async () => {
  const openai = {
    chat: { completions: { create: async (args) => {
      const isGate = args.messages[0].content.includes('decide whether a user query');
      if (isGate) return { choices: [{ message: { content: JSON.stringify({ retrieve: true, reason: '' }) } }] };
      throw new Error('rater down');
    }}},
  };
  const retrieve = async () => [{ source: 'a', text: 'A' }];
  const generate = async ({ passages }) => `kept=${passages.length}`;
  const r = await ap.selfRag({ openai, query: 'q', retrieve, generate });
  assert.equal(r.kept.length, 1);
});

// ─── CRAG ────────────────────────────────────────────────────────────────

test('crag: grade=correct → trust-initial path', async () => {
  const openai = scripted([
    JSON.stringify({ grade: 'correct', confidence: 0.9, reason: '' }),
  ]);
  const retrieve = async () => [{ source: 'a', text: 'A' }];
  const generate = async () => 'answer';
  const r = await ap.crag({ openai, query: 'q', retrieve, generate });
  assert.equal(r.path, 'trust-initial');
  assert.equal(r.grade, 'correct');
});

test('crag: grade=ambiguous → decompose path when decomposer supplied', async () => {
  const openai = scripted([
    JSON.stringify({ grade: 'ambiguous', confidence: 0.4, reason: '' }),
  ]);
  const retrieveCalls = [];
  const retrieve = async (q) => { retrieveCalls.push(q); return [{ source: q, text: q }]; };
  const generate = async () => 'combined answer';
  const decompose = async () => ['sub1', 'sub2'];
  const r = await ap.crag({ openai, query: 'q', retrieve, generate, decompose });
  assert.equal(r.path, 'decomposed-retry');
  assert.ok(retrieveCalls.length >= 3, `expected 1 initial + 2 sub retrievals, got ${retrieveCalls.length}`);
});

test('crag: grade=incorrect + externalSearch wired → external-search path', async () => {
  const openai = scripted([
    JSON.stringify({ grade: 'incorrect', confidence: 0.2, reason: 'off-topic' }),
  ]);
  const retrieve = async () => [{ source: 'bad', text: 'wrong' }];
  let searched = false;
  const externalSearch = async () => { searched = true; return [{ source: 'web', text: 'right' }]; };
  const generate = async ({ passages }) => `using ${passages.map(p => p.source).join(',')}`;
  const r = await ap.crag({ openai, query: 'q', retrieve, generate, externalSearch });
  assert.equal(searched, true);
  assert.equal(r.path, 'external-search');
  assert.match(r.answer, /web/);
});

test('crag: grade=incorrect but no externalSearch → degraded-fallback', async () => {
  const openai = scripted([
    JSON.stringify({ grade: 'incorrect', confidence: 0.1, reason: '' }),
  ]);
  const retrieve = async () => [{ source: 'x', text: 'X' }];
  const generate = async () => 'a';
  const r = await ap.crag({ openai, query: 'q', retrieve, generate });
  assert.equal(r.path, 'degraded-fallback');
});

// ─── FLARE ───────────────────────────────────────────────────────────────

test('flare: high-confidence step emits sentence without retrieval', async () => {
  const openai = scripted([
    JSON.stringify({ sentence: 'The capital of France is Paris.', confidence: 0.95, needs_retrieval: false, retrieval_query: '', done: true }),
  ]);
  let retrieveCalls = 0;
  const retrieve = async () => { retrieveCalls++; return []; };
  const r = await ap.flare({ openai, query: 'capital of France?', retrieve, maxSentences: 3 });
  assert.equal(retrieveCalls, 0);
  assert.equal(r.sentences.length, 1);
  assert.match(r.answer, /Paris/);
});

test('flare: low confidence triggers retrieval + retry', async () => {
  const openai = scripted([
    // Step 1: low confidence → asks for retrieval
    JSON.stringify({ sentence: '', confidence: 0.3, needs_retrieval: true, retrieval_query: 'what is X', done: false }),
    // Retry after retrieve
    JSON.stringify({ sentence: 'X is the answer.', confidence: 0.9, needs_retrieval: false, retrieval_query: '', done: true }),
  ]);
  let retrieveCalls = 0;
  const retrieve = async () => { retrieveCalls++; return [{ source: 'hit', text: 'X is the answer' }]; };
  const r = await ap.flare({ openai, query: 'q', retrieve, maxSentences: 3 });
  assert.equal(retrieveCalls, 1);
  assert.match(r.answer, /X is the answer/);
  const retrieveTrace = r.trace.find(t => t.action === 'retrieve');
  assert.ok(retrieveTrace, 'retrieve step should appear in trace');
});

test('flare: respects maxSentences cap', async () => {
  // Script always emits a sentence, never done. Cap should stop us.
  const alwaysEmit = JSON.stringify({
    sentence: 'another sentence', confidence: 0.9, needs_retrieval: false, retrieval_query: '', done: false,
  });
  const openai = scripted([alwaysEmit]);
  const retrieve = async () => [];
  const r = await ap.flare({ openai, query: 'q', retrieve, maxSentences: 2 });
  assert.equal(r.sentences.length, 2);
});

test('flare: missing retrieve fn rejected', async () => {
  await assert.rejects(
    ap.flare({ openai: scripted([]), query: 'q' }),
    /retrieve\(fn\) required/,
  );
});
