/**
 * Tests for query-decomposer.
 *
 * No real LLM calls — every test injects a fake openai client whose
 * chat.completions.create returns a canned envelope. Coverage:
 *   - Happy path returns the strict shape
 *   - Sub-queries are deduped, trimmed, capped at MAX_SUBQUERIES,
 *     and overflow paragraphs are dropped
 *   - combine snaps to 'concat' on unknown values
 *   - Missing subqueries[] falls back to the original question
 *   - Typed errors for missing client / blank question / SDK throw / invalid JSON
 *   - rationale is whitespace-collapsed and clipped to 280 chars
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dq = require('../src/services/rag/query-decomposer');

function fakeOpenai(payload, opts = {}) {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (req) => {
          calls.push(req);
          if (opts.throws) throw opts.throws;
          const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  client.__calls = calls;
  return client;
}

const sample = {
  subqueries: [
    'What is the refund policy?',
    'What is the Q2 2025 churn discount?',
    'Do refunds and the churn discount overlap?',
  ],
  rationale: 'Three independent hops, all needed for a complete answer.',
  combine: 'concat',
};

// ── happy path ────────────────────────────────────────────────────────────

test('decomposeQuery returns the strict envelope on a clean response', async () => {
  const openai = fakeOpenai(sample);
  const out = await dq.decomposeQuery({
    openai,
    question: 'What is our refund policy and how does it interact with the Q2 2025 churn discount?',
  });
  assert.equal(out.subqueries.length, 3);
  assert.equal(out.combine, 'concat');
  assert.equal(out.rationale, sample.rationale);
  assert.equal(out.meta.subqueryCount, 3);
  assert.ok(out.meta.model);
});

test('decomposeQuery forwards languageHint into the user prompt', async () => {
  const openai = fakeOpenai(sample);
  await dq.decomposeQuery({
    openai,
    question: '¿Cuál es la política de reembolsos?',
    options: { languageHint: 'es' },
  });
  const userMessage = openai.__calls[0].messages[1].content;
  assert.match(userMessage, /Probable language: es/);
});

// ── normalizeDecomposition defenses ──────────────────────────────────────

test('clampSubqueries dedupes case-insensitively and caps at MAX_SUBQUERIES', () => {
  const out = dq.clampSubqueries([
    'first',
    'FIRST',
    'second',
    'third',
    'fourth',
    'fifth',
    'sixth',
  ]);
  assert.equal(out.length, dq.MAX_SUBQUERIES);
  assert.deepEqual(out.slice(0, 3), ['first', 'second', 'third']);
});

test('clampSubqueries drops empty / non-string / oversized items', () => {
  const out = dq.clampSubqueries(['ok', '', '   ', null, 12, 'X'.repeat(500)]);
  assert.deepEqual(out, ['ok']);
});

test('normalizeDecomposition falls back to the original question when subqueries are empty', () => {
  const out = dq.normalizeDecomposition({ subqueries: [] }, 'unsplit question', 'gpt-x');
  assert.deepEqual(out.subqueries, ['unsplit question']);
  assert.equal(out.combine, 'concat');
});

test('normalizeDecomposition snaps unknown combine to concat', () => {
  const out = dq.normalizeDecomposition({ subqueries: ['a'], combine: 'cosmic' }, 'q', 'gpt-x');
  assert.equal(out.combine, 'concat');
});

test('normalizeDecomposition keeps known combine values', () => {
  for (const v of ['concat', 'intersect', 'sequence']) {
    const out = dq.normalizeDecomposition({ subqueries: ['a'], combine: v }, 'q', 'gpt-x');
    assert.equal(out.combine, v);
  }
});

test('normalizeDecomposition collapses + clips rationale at 280 chars', () => {
  const long = 'word '.repeat(200);
  const out = dq.normalizeDecomposition({ subqueries: ['a'], rationale: long }, 'q', 'gpt-x');
  assert.ok(out.rationale.length <= 280);
  assert.ok(!out.rationale.includes('  '));
});

// ── error mapping ─────────────────────────────────────────────────────────

test('decomposeQuery throws query_decomposer_no_client when openai is missing', async () => {
  await assert.rejects(
    () => dq.decomposeQuery({ question: 'q' }),
    (err) => err.code === 'query_decomposer_no_client',
  );
});

test('decomposeQuery throws query_decomposer_empty on blank question', async () => {
  const openai = fakeOpenai(sample);
  await assert.rejects(
    () => dq.decomposeQuery({ openai, question: '   \n  ' }),
    (err) => err.code === 'query_decomposer_empty',
  );
});

test('decomposeQuery wraps SDK errors with query_decomposer_llm_failed', async () => {
  const openai = fakeOpenai(null, { throws: new Error('429 rate limit') });
  await assert.rejects(
    () => dq.decomposeQuery({ openai, question: 'q' }),
    (err) => {
      assert.equal(err.code, 'query_decomposer_llm_failed');
      assert.ok(err.cause);
      return true;
    },
  );
});

test('decomposeQuery raises query_decomposer_invalid_json on garbage output', async () => {
  const openai = fakeOpenai('this is not JSON');
  await assert.rejects(
    () => dq.decomposeQuery({ openai, question: 'q' }),
    (err) => err.code === 'query_decomposer_invalid_json',
  );
});
