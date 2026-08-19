/**
 * Tests for ITER-RETGEN + IRCoT iterative retrieval loops.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const ir = require('../src/services/rag/iterative-retgen');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── answerStabilised ────────────────────────────────────────────────────

test('answerStabilised: same string → true', () => {
  assert.equal(ir.answerStabilised('hello world', 'hello world'), true);
});

test('answerStabilised: very different → false', () => {
  assert.equal(ir.answerStabilised(
    'The capital of France is Paris, located on the Seine.',
    'Cats are small carnivorous mammals that purr when content.',
  ), false);
});

test('answerStabilised: nearly-duplicate drafts → true', () => {
  const a = 'The Eiffel Tower was completed in 1889 for the 1889 Paris World Fair.';
  const b = 'The Eiffel Tower was completed in 1889 for the 1889 World Fair in Paris.';
  assert.equal(ir.answerStabilised(a, b, 0.5), true);
});

// ─── iterRetgen ──────────────────────────────────────────────────────────

test('iterRetgen: runs max-iterations when drafts diverge', async () => {
  let genCount = 0;
  const generate = async () => `draft ${++genCount} with completely different content ${Date.now()}`;
  const retrieve = async () => [{ source: `r${Date.now()}`, text: 'new passage' }];
  const r = await ir.iterRetgen({
    query: 'q', retrieve, generate, iterations: 3,
  });
  assert.equal(r.rounds.length, 3);
  assert.equal(r.stopped, 'max-iterations');
});

test('iterRetgen: early-stops on stable draft', async () => {
  const stable = 'The answer is 42 because the long explanation follows consistent reasoning across iterations.';
  const generate = async () => stable;
  const retrieve = async () => [{ source: 'r', text: 'p' }];
  const r = await ir.iterRetgen({
    query: 'q', retrieve, generate, iterations: 5,
  });
  // First round establishes baseline, second round would match → stable
  assert.equal(r.stopped, 'stable');
  assert.ok(r.rounds.length <= 3);
});

test('iterRetgen: accumulates passages across iterations', async () => {
  let r = 0;
  const retrieve = async () => {
    r++;
    return [{ source: `r${r}`, text: `passage ${r}` }];
  };
  const generate = async () => `draft round ${r} distinct content for divergence threshold`;
  const out = await ir.iterRetgen({
    query: 'q', retrieve, generate, iterations: 3,
  });
  assert.ok(out.passages.length >= 2, `expected accumulated passages, got ${out.passages.length}`);
});

test('iterRetgen: missing retrieve fn rejected', async () => {
  await assert.rejects(
    ir.iterRetgen({ query: 'q', generate: async () => '' }),
    /retrieve\(fn\) required/,
  );
});

test('iterRetgen: missing generate fn rejected', async () => {
  await assert.rejects(
    ir.iterRetgen({ query: 'q', retrieve: async () => [] }),
    /generate\(fn\) required/,
  );
});

// ─── IRCoT ───────────────────────────────────────────────────────────────

test('ircot: emits steps + retrieves per step until final_answer', async () => {
  const openai = scripted([
    JSON.stringify({ step: 'First, identify the subject.', retrieval_query: 'about X', final_answer: '' }),
    JSON.stringify({ step: 'Then, combine facts.', retrieval_query: 'how X relates to Y', final_answer: '' }),
    JSON.stringify({ step: 'Therefore the answer follows.', retrieval_query: '', final_answer: 'The answer is Z.' }),
  ]);
  const retrievalQueries = [];
  const retrieve = async (q) => {
    retrievalQueries.push(q);
    return [{ source: q, text: `passage for ${q}` }];
  };
  const r = await ir.ircot({ openai, query: 'multi-hop q', retrieve, maxSteps: 5 });
  assert.equal(r.stopped, 'final-answer');
  assert.match(r.answer, /The answer is Z/);
  assert.equal(r.steps.length, 3);
  assert.ok(retrievalQueries.includes('about X'));
  assert.ok(retrievalQueries.includes('how X relates to Y'));
});

test('ircot: hits maxSteps without final_answer', async () => {
  const openai = scripted([
    JSON.stringify({ step: 'step 1', retrieval_query: 'q1', final_answer: '' }),
  ]);
  const retrieve = async () => [];
  const r = await ir.ircot({ openai, query: 'q', retrieve, maxSteps: 2 });
  assert.equal(r.stopped, 'max-steps');
  assert.equal(r.steps.length, 2);
});

test('ircot: handles empty retrieval_query without crashing', async () => {
  const openai = scripted([
    JSON.stringify({ step: 'direct answer', retrieval_query: '', final_answer: 'the answer' }),
  ]);
  const retrieve = async () => { throw new Error('should not be called'); };
  const r = await ir.ircot({ openai, query: 'q', retrieve, maxSteps: 3 });
  assert.equal(r.answer, 'the answer');
});

test('ircot: LLM error stops the loop', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('down'); } } },
  };
  const retrieve = async () => [];
  const r = await ir.ircot({ openai, query: 'q', retrieve, maxSteps: 3 });
  assert.equal(r.steps.length, 1);
  assert.match(r.steps[0].step, /LLM error/);
});
