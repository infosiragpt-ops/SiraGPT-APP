/**
 * Tests for ARES auto-evaluator.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const ares = require('../src/services/rag/ares-eval');

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

// ─── formatFewShots ──────────────────────────────────────────────────────

test('formatFewShots: lays out examples with label + reason', () => {
  const s = ares.formatFewShots('context_relevance', [
    { question: 'q1', passages: ['p1'], label: 1, reason: 'good' },
    { question: 'q2', passages: ['p2'], label: 0, reason: 'bad' },
  ]);
  assert.match(s, /EXAMPLE 1/);
  assert.match(s, /EXAMPLE 2/);
  assert.match(s, /LABEL: 1/);
  assert.match(s, /LABEL: 0/);
});

test('formatFewShots: handles missing passages / answers', () => {
  const s = ares.formatFewShots('answer_relevance', [
    { question: 'q', answer: 'a', label: 1, reason: '' },
  ]);
  assert.match(s, /ANSWER: a/);
  assert.ok(!s.includes('PASSAGES'));
});

// ─── scoreContextRelevance ───────────────────────────────────────────────

test('scoreContextRelevance: label 1 → score 1', async () => {
  const openai = scripted([JSON.stringify({ score: 1, reason: 'passage answers directly' })]);
  const r = await ares.scoreContextRelevance({
    openai,
    question: 'when was X built?',
    passages: [{ text: 'X was built in 1889.' }],
  });
  assert.equal(r.score, 1);
  assert.match(r.reason, /answers directly/);
});

test('scoreContextRelevance: label 0 → score 0', async () => {
  const openai = scripted([JSON.stringify({ score: 0, reason: 'off topic' })]);
  const r = await ares.scoreContextRelevance({
    openai,
    question: 'when was X built?',
    passages: [{ text: 'Y is unrelated.' }],
  });
  assert.equal(r.score, 0);
});

test('scoreContextRelevance: score as string "1" normalised to 1', async () => {
  const openai = scripted([JSON.stringify({ score: '1', reason: '' })]);
  const r = await ares.scoreContextRelevance({
    openai,
    question: 'q', passages: [{ text: 'p' }],
  });
  assert.equal(r.score, 1);
});

test('scoreContextRelevance: null openai → score 0 with reason', async () => {
  const r = await ares.scoreContextRelevance({ openai: null, question: 'q', passages: [] });
  assert.equal(r.score, 0);
  assert.match(r.reason, /no LLM/);
});

// ─── scoreFaithfulness ───────────────────────────────────────────────────

test('scoreFaithfulness: answer supported by passage → 1', async () => {
  const openai = scripted([JSON.stringify({ score: 1, reason: 'answer restates passage' })]);
  const r = await ares.scoreFaithfulness({
    openai,
    passages: [{ text: 'Water boils at 100°C.' }],
    answer: 'Water boils at 100°C.',
  });
  assert.equal(r.score, 1);
});

test('scoreFaithfulness: answer contradicts passage → 0', async () => {
  const openai = scripted([JSON.stringify({ score: 0, reason: 'contradicts' })]);
  const r = await ares.scoreFaithfulness({
    openai,
    passages: [{ text: 'Water boils at 100°C.' }],
    answer: 'Water boils at 98.7°C.',
  });
  assert.equal(r.score, 0);
});

// ─── scoreAnswerRelevance ────────────────────────────────────────────────

test('scoreAnswerRelevance: on-topic → 1', async () => {
  const openai = scripted([JSON.stringify({ score: 1, reason: 'direct' })]);
  const r = await ares.scoreAnswerRelevance({
    openai,
    question: 'Who painted the Mona Lisa?',
    answer: 'Leonardo da Vinci.',
  });
  assert.equal(r.score, 1);
});

// ─── evaluateItem ────────────────────────────────────────────────────────

test('evaluateItem: all three axes called in parallel', async () => {
  const openai = scripted([
    JSON.stringify({ score: 1, reason: 'ctx' }),
    JSON.stringify({ score: 1, reason: 'faith' }),
    JSON.stringify({ score: 0, reason: 'relevance off' }),
  ]);
  const r = await ares.evaluateItem({
    openai,
    question: 'q',
    passages: [{ text: 'p' }],
    answer: 'a',
  });
  assert.equal(r.context_relevance.score, 1);
  assert.equal(r.answer_faithfulness.score, 1);
  assert.equal(r.answer_relevance.score, 0);
  assert.ok(Math.abs(r.overall - (2 / 3)) < 1e-9);
  assert.equal(openai.calls.length, 3);
});

// ─── evaluateDataset ─────────────────────────────────────────────────────

test('evaluateDataset: aggregates axis averages + overall', async () => {
  const openai = scripted([
    // Item 1: 1,1,1
    JSON.stringify({ score: 1, reason: '' }),
    JSON.stringify({ score: 1, reason: '' }),
    JSON.stringify({ score: 1, reason: '' }),
    // Item 2: 0,0,0
    JSON.stringify({ score: 0, reason: '' }),
    JSON.stringify({ score: 0, reason: '' }),
    JSON.stringify({ score: 0, reason: '' }),
  ]);
  const r = await ares.evaluateDataset({
    openai,
    items: [
      { question: 'q1', passages: [{ text: 'p1' }], answer: 'a1' },
      { question: 'q2', passages: [{ text: 'p2' }], answer: 'a2' },
    ],
  });
  assert.equal(r.total, 2);
  assert.equal(r.axes.context_relevance, 0.5);
  assert.equal(r.axes.answer_faithfulness, 0.5);
  assert.equal(r.axes.answer_relevance, 0.5);
  assert.equal(r.overall, 0.5);
});

test('evaluateDataset: empty items', async () => {
  const r = await ares.evaluateDataset({ openai: scripted([]), items: [] });
  assert.equal(r.total, 0);
  assert.equal(r.overall, 0);
});

test('evaluateDataset: null openai rejected', async () => {
  await assert.rejects(
    ares.evaluateDataset({ openai: null, items: [{ question: 'q', passages: [], answer: 'a' }] }),
    /openai client required/,
  );
});
