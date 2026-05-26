/**
 * Unit tests for the RAGAS suite:
 *   faithfulness, answer_relevancy, context_precision, context_recall,
 *   combined evaluate + evaluateBatch.
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

const ragas = require('../src/services/agents/ragas');

// Helper: scripted chat with sequential responses
function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    })}},
  };
}
// Test embedder
const testEmbedder = async (texts) => texts.map(fakeVectorFor);

// ─── Faithfulness ─────────────────────────────────────────────────────────

test('faithfulness: all claims supported → score 1', async () => {
  const openai = scripted([
    JSON.stringify({ claims: ['The sky is blue', 'Water boils at 100C'] }),
    JSON.stringify({ verdicts: [
      { supported: true, evidence: 'ev1' },
      { supported: true, evidence: 'ev2' },
    ]}),
  ]);
  const r = await ragas.faithfulness.compute({
    openai, question: 'q', answer: 'a',
    retrievedContexts: [{ text: 'context' }],
  });
  assert.equal(r.score, 1);
  assert.equal(r.n_claims, 2);
  assert.equal(r.supported_claims, 2);
});

test('faithfulness: half supported → score 0.5', async () => {
  const openai = scripted([
    JSON.stringify({ claims: ['A', 'B', 'C', 'D'] }),
    JSON.stringify({ verdicts: [
      { supported: true }, { supported: false },
      { supported: true }, { supported: false },
    ]}),
  ]);
  const r = await ragas.faithfulness.compute({
    openai, question: 'q', answer: 'a', retrievedContexts: [],
  });
  assert.equal(r.score, 0.5);
});

test('faithfulness: empty claims → score 1 (vacuously faithful)', async () => {
  const openai = scripted([JSON.stringify({ claims: [] })]);
  const r = await ragas.faithfulness.compute({
    openai, question: 'q', answer: 'Pure opinion, no facts.', retrievedContexts: [],
  });
  assert.equal(r.score, 1);
  assert.equal(r.n_claims, 0);
  assert.ok(r.note);
});

test('faithfulness: LLM parse errors default to unsupported', async () => {
  const openai = scripted([
    JSON.stringify({ claims: ['claim1', 'claim2'] }),
    'not json at all',
  ]);
  const r = await ragas.faithfulness.compute({
    openai, question: 'q', answer: 'a', retrievedContexts: [],
  });
  assert.equal(r.score, 0);
});

// ─── Answer relevancy ────────────────────────────────────────────────────

test('answer_relevancy: reconstructed questions similar to original → high score', async () => {
  // We stub the LLM to reconstruct the SAME question text. With our
  // deterministic embedder, identical text → identical vector → cosine 1.
  const openai = scripted([
    JSON.stringify({ questions: ['What is photosynthesis?', 'What is photosynthesis?', 'What is photosynthesis?'] }),
  ]);
  const r = await ragas.answerRelevancy.compute({
    openai,
    question: 'What is photosynthesis?',
    answer: 'Photosynthesis is the process of making food from light.',
    embedder: testEmbedder,
    n: 3,
  });
  assert.ok(r.score > 0.95);
  assert.equal(r.reconstructed_questions.length, 3);
});

test('answer_relevancy: off-topic reconstructions → low score', async () => {
  const openai = scripted([
    JSON.stringify({ questions: ['What is quantum computing?', 'How does a GPU work?', 'What is blockchain?'] }),
  ]);
  const r = await ragas.answerRelevancy.compute({
    openai,
    question: 'What is photosynthesis?',
    answer: 'Random unrelated content about GPUs.',
    embedder: testEmbedder, n: 3,
  });
  assert.ok(r.score < 0.9);
});

test('answer_relevancy: missing embedder throws', async () => {
  await assert.rejects(ragas.answerRelevancy.compute({
    openai: scripted([]), question: 'q', answer: 'a',
  }), /embedder function required/);
});

test('answer_relevancy: empty reconstruction → score 0', async () => {
  const openai = scripted(['not json']);
  const r = await ragas.answerRelevancy.compute({
    openai, question: 'q', answer: 'a', embedder: testEmbedder, n: 3,
  });
  assert.equal(r.score, 0);
});

// ─── Context precision ──────────────────────────────────────────────────

test('context_precision: all relevant chunks → score 1', async () => {
  const openai = scripted([
    JSON.stringify({ verdicts: [
      { idx: 1, relevant: true }, { idx: 2, relevant: true }, { idx: 3, relevant: true },
    ]}),
  ]);
  const r = await ragas.contextPrecision.compute({
    openai, question: 'q',
    retrievedContexts: [{ text: 'c1' }, { text: 'c2' }, { text: 'c3' }],
  });
  assert.equal(r.score, 1);
});

test('context_precision: no relevant chunks → score 0', async () => {
  const openai = scripted([
    JSON.stringify({ verdicts: [
      { idx: 1, relevant: false }, { idx: 2, relevant: false },
    ]}),
  ]);
  const r = await ragas.contextPrecision.compute({
    openai, question: 'q',
    retrievedContexts: [{ text: 'c1' }, { text: 'c2' }],
  });
  assert.equal(r.score, 0);
});

test('context_precision: relevant at top > relevant at bottom', async () => {
  // Scenario A: first chunk relevant, others not → p@1 = 1
  const openaiA = scripted([
    JSON.stringify({ verdicts: [
      { idx: 1, relevant: true }, { idx: 2, relevant: false }, { idx: 3, relevant: false },
    ]}),
  ]);
  const rA = await ragas.contextPrecision.compute({
    openai: openaiA, question: 'q',
    retrievedContexts: [{ text: 'c1' }, { text: 'c2' }, { text: 'c3' }],
  });

  // Scenario B: last chunk relevant → weighted lower
  const openaiB = scripted([
    JSON.stringify({ verdicts: [
      { idx: 1, relevant: false }, { idx: 2, relevant: false }, { idx: 3, relevant: true },
    ]}),
  ]);
  const rB = await ragas.contextPrecision.compute({
    openai: openaiB, question: 'q',
    retrievedContexts: [{ text: 'c1' }, { text: 'c2' }, { text: 'c3' }],
  });

  // Same # relevant (1), but A has it at the top → A should score higher.
  assert.ok(rA.score > rB.score,
    `top-ranked relevance should beat bottom-ranked (A=${rA.score}, B=${rB.score})`);
});

test('context_precision: empty contexts → score 0', async () => {
  const r = await ragas.contextPrecision.compute({
    openai: scripted([]), question: 'q', retrievedContexts: [],
  });
  assert.equal(r.score, 0);
});

// ─── Context recall ─────────────────────────────────────────────────────

test('context_recall: all statements attributable → score 1', async () => {
  const openai = scripted([
    JSON.stringify({ statements: ['Paris is the capital of France', 'It has 2M residents'] }),
    JSON.stringify({ attributions: [
      { idx: 1, attributable: true }, { idx: 2, attributable: true },
    ]}),
  ]);
  const r = await ragas.contextRecall.compute({
    openai,
    groundTruth: 'Paris is the capital of France with about 2 million residents.',
    retrievedContexts: [{ text: 'Paris, capital of France, 2M people' }],
  });
  assert.equal(r.score, 1);
  assert.equal(r.n_statements, 2);
});

test('context_recall: half attributable → score 0.5', async () => {
  const openai = scripted([
    JSON.stringify({ statements: ['A', 'B', 'C', 'D'] }),
    JSON.stringify({ attributions: [
      { idx: 1, attributable: true }, { idx: 2, attributable: false },
      { idx: 3, attributable: true }, { idx: 4, attributable: false },
    ]}),
  ]);
  const r = await ragas.contextRecall.compute({
    openai, groundTruth: 'gt', retrievedContexts: [{ text: 'ctx' }],
  });
  assert.equal(r.score, 0.5);
});

test('context_recall: empty ground-truth claims → score 0 with note', async () => {
  const openai = scripted([JSON.stringify({ statements: [] })]);
  const r = await ragas.contextRecall.compute({
    openai, groundTruth: 'fluff', retrievedContexts: [],
  });
  assert.equal(r.score, 0);
  assert.ok(r.note);
});

// ─── Combined evaluate ─────────────────────────────────────────────────

test('evaluate: combines 4 metrics when groundTruth provided', async () => {
  // Simulate all 4 sub-judges returning perfect scores.
  const openai = {
    chat: { completions: { create: async ({ messages }) => {
      const sys = messages.find(m => m.role === 'system')?.content || '';
      // Route responses by the system prompt content.
      if (sys.includes('Extract atomic factual CLAIMS from the given ANSWER')) {
        return { choices: [{ message: { content: JSON.stringify({ claims: ['c1'] }) } }] };
      }
      if (sys.includes('For each STATEMENT, decide whether it is supported')) {
        return { choices: [{ message: { content: JSON.stringify({ verdicts: [{ supported: true }] }) } }] };
      }
      if (sys.includes('generate 3 distinct questions') || sys.includes('N potential questions') || sys.includes('generate')) {
        return { choices: [{ message: { content: JSON.stringify({ questions: ['q1', 'q1', 'q1'] }) } }] };
      }
      if (sys.includes('Decide whether a retrieved PASSAGE contains')) {
        return { choices: [{ message: { content: JSON.stringify({ verdicts: [{ idx: 1, relevant: true }] }) } }] };
      }
      if (sys.includes('Break the GROUND_TRUTH_ANSWER into atomic statements')) {
        return { choices: [{ message: { content: JSON.stringify({ statements: ['s1'] }) } }] };
      }
      if (sys.includes('For each STATEMENT') && sys.includes('attributable to the CONTEXT')) {
        return { choices: [{ message: { content: JSON.stringify({ attributions: [{ idx: 1, attributable: true }] }) } }] };
      }
      return { choices: [{ message: { content: '{}' } }] };
    }}},
  };
  const r = await ragas.evaluate({
    openai,
    question: 'q1',
    answer: 'a1',
    retrievedContexts: [{ text: 'c1' }],
    groundTruth: 'gt1',
    embedder: testEmbedder,
  });
  assert.ok(r.faithfulness);
  assert.ok(r.answer_relevancy);
  assert.ok(r.context_precision);
  assert.ok(r.context_recall);
  assert.ok(r.aggregate > 0.9);
});

test('evaluate: 3 metrics when no groundTruth', async () => {
  const openai = scripted([
    JSON.stringify({ claims: [] }), // faithfulness: no claims → score 1
    JSON.stringify({ questions: ['q', 'q', 'q'] }), // reconstructed = original
    JSON.stringify({ verdicts: [{ idx: 1, relevant: true }] }),
  ]);
  const r = await ragas.evaluate({
    openai,
    question: 'q',
    answer: 'pure opinion',
    retrievedContexts: [{ text: 'ctx' }],
    embedder: testEmbedder,
  });
  assert.equal(r.context_recall, null);
  assert.ok(r.aggregate > 0);
});

test('evaluate: missing openai throws', async () => {
  await assert.rejects(ragas.evaluate({
    question: 'q', answer: 'a', retrievedContexts: [],
    embedder: testEmbedder,
  }), /openai required/);
});

test('evaluateBatch: aggregates per-metric mean + std', async () => {
  // Build a stub that cycles through responses so each example's
  // 3 metric calls get proper responses.
  let call = 0;
  const responses = [
    // example 1
    JSON.stringify({ claims: [] }),
    JSON.stringify({ questions: ['q1', 'q1', 'q1'] }),
    JSON.stringify({ verdicts: [{ idx: 1, relevant: true }] }),
    // example 2
    JSON.stringify({ claims: [] }),
    JSON.stringify({ questions: ['q2', 'q2', 'q2'] }),
    JSON.stringify({ verdicts: [{ idx: 1, relevant: false }] }),
  ];
  const openai = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: responses[Math.min(call++, responses.length - 1)] } }],
  })}}};

  const r = await ragas.evaluateBatch({
    openai,
    examples: [
      { id: 'a', question: 'q1', answer: 'a', retrievedContexts: [{ text: 'ctx' }] },
      { id: 'b', question: 'q2', answer: 'a', retrievedContexts: [{ text: 'ctx' }] },
    ],
    embedder: testEmbedder,
  });
  assert.equal(r.n, 2);
  assert.ok(r.aggregate.faithfulness.mean !== null);
  assert.ok(r.aggregate.context_precision.mean !== null);
});

test('evaluateBatch: empty examples → n=0 result', async () => {
  const r = await ragas.evaluateBatch({
    openai: scripted([]), examples: [], embedder: testEmbedder,
  });
  assert.equal(r.n, 0);
  assert.deepEqual(r.perExample, []);
});
