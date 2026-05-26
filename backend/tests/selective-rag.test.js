/**
 * Tests for Repoformer-style selective-RAG gate.
 *
 * Heuristic cases run offline. For the classifier path we stub a
 * scripted OpenAI client.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const sel = require('../src/services/agents/selective-rag');

// ─── heuristic ───────────────────────────────────────────────────────────

test('heuristic: explicit project reference → retrieve', () => {
  for (const q of [
    'en este repo, dónde se valida el email',
    'in our codebase, where is the AuthMiddleware defined',
    'refactor UserService.findByEmail to accept an array of emails',
    'update the function handleLogin in src/auth/login.ts',
  ]) {
    const d = sel.heuristic(q);
    assert.equal(d.decision, 'retrieve', `expected retrieve for "${q}"`);
    assert.ok(d.confidence > 0.6);
  }
});

test('heuristic: general-knowledge / language questions → skip', () => {
  for (const q of [
    'what is a Python list comprehension',
    'explica cómo funciona async await en JavaScript',
    'difference between a stack and a queue',
    'time complexity of merge sort',
    'diferencia entre map y forEach',
  ]) {
    const d = sel.heuristic(q);
    assert.equal(d.decision, 'skip', `expected skip for "${q}"`);
  }
});

test('heuristic: empty / too-short inputs → skip', () => {
  assert.equal(sel.heuristic('').decision, 'skip');
  assert.equal(sel.heuristic('   ').decision, 'skip');
  assert.equal(sel.heuristic('hi').decision, 'skip');
});

test('heuristic: genuinely uncertain query → uncertain', () => {
  const d = sel.heuristic('how should I structure a CLI tool');
  assert.equal(d.decision, 'uncertain');
});

// ─── decide: heuristic resolution ────────────────────────────────────────

test('decide: heuristic=retrieve short-circuits without LLM', async () => {
  const d = await sel.decide({
    query: 'refactor UserService.findByEmail in our codebase',
    openai: null,  // no LLM — heuristic must resolve
  });
  assert.equal(d.shouldRetrieve, true);
  assert.equal(d.source, 'heuristic');
});

test('decide: heuristic=skip with high confidence → skip without LLM', async () => {
  const d = await sel.decide({
    query: 'what is a Python list comprehension',
    openai: null,
  });
  assert.equal(d.shouldRetrieve, false);
  assert.equal(d.source, 'heuristic');
});

test('decide: uncertain + no LLM → default retrieve (safety bias)', async () => {
  const d = await sel.decide({
    query: 'how should I structure a CLI tool',
    openai: null,
  });
  assert.equal(d.shouldRetrieve, true);
  assert.match(d.reason, /default retrieve/);
});

// ─── decide: classifier path ─────────────────────────────────────────────

test('decide: uncertain heuristic → classifier is called', async () => {
  let called = false;
  const openai = {
    chat: { completions: { create: async () => {
      called = true;
      return {
        choices: [{ message: { content: JSON.stringify({
          shouldRetrieve: true, confidence: 0.72, reason: 'mentions a project-specific module',
        }) } }],
      };
    } } },
  };
  const d = await sel.decide({
    query: 'how should I structure a CLI tool',
    openai,
  });
  assert.ok(called, 'classifier should have been called for uncertain query');
  assert.equal(d.source, 'classifier');
  assert.equal(d.shouldRetrieve, true);
  assert.equal(d.confidence, 0.72);
});

test('decide: classifier vote skip honoured', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({
        shouldRetrieve: false, confidence: 0.9, reason: 'pure language question',
      }) } }],
    }) } },
  };
  const d = await sel.decide({
    query: 'how should I structure a CLI tool',
    openai,
  });
  assert.equal(d.shouldRetrieve, false);
  assert.equal(d.source, 'classifier');
});

test('decide: classifier returns malformed JSON → default shouldRetrieve=false (from missing field)', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: 'not valid json' } }],
    }) } },
  };
  const d = await sel.decide({
    query: 'how should I structure a CLI tool',
    openai,
  });
  // Classifier returned garbage → shouldRetrieve falls to false, but
  // call `source` is still 'classifier' since we did run it.
  assert.equal(d.source, 'classifier');
  assert.equal(d.shouldRetrieve, false);
});

// ─── classify: direct ────────────────────────────────────────────────────

test('classify: clamps confidence to [0,1]', async () => {
  const openai = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: JSON.stringify({
        shouldRetrieve: true, confidence: 5, reason: '',
      }) } }],
    }) } },
  };
  const r = await sel.classify({ openai, query: 'x' });
  assert.equal(r.confidence, 1);
});
