/**
 * Tests for HyDE / step-back / decompose query transforms.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const qt = require('../src/services/rag/query-transforms');

function scripted(seq) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      const content = seq[Math.min(i++, seq.length - 1)];
      return { choices: [{ message: { content } }] };
    }}},
  };
}

// ─── HyDE ────────────────────────────────────────────────────────────────

test('hyde: keeps original + adds hypothetical passage', async () => {
  const openai = scripted([
    JSON.stringify({ passage: 'Cosmic rays originate primarily from supernova explosions and reach Earth\'s upper atmosphere.' }),
  ]);
  const r = await qt.hyde({ openai, query: 'where do cosmic rays come from?' });
  assert.equal(r.queries.length, 2);
  assert.equal(r.queries[0], 'where do cosmic rays come from?');
  assert.match(r.queries[1], /supernova/);
  assert.equal(r.trace.strategy, 'hyde');
});

test('hyde: keepOriginal=false drops the question', async () => {
  const openai = scripted([JSON.stringify({ passage: 'some answer' })]);
  const r = await qt.hyde({ openai, query: 'q', keepOriginal: false });
  assert.equal(r.queries.length, 1);
  assert.equal(r.queries[0], 'some answer');
});

test('hyde: null openai → returns original alone', async () => {
  const r = await qt.hyde({ openai: null, query: 'q' });
  assert.deepEqual(r.queries, ['q']);
  assert.equal(r.trace.passage, '');
});

test('hyde: empty query → empty queries list', async () => {
  const r = await qt.hyde({ openai: scripted([]), query: '' });
  assert.deepEqual(r.queries, []);
});

// ─── Step-back ───────────────────────────────────────────────────────────

test('step-back: produces abstract + keeps original', async () => {
  const openai = scripted([
    JSON.stringify({ stepBack: 'What is the student body composition?' }),
  ]);
  const r = await qt.stepBack({ openai, query: 'What countries did 2007 students come from?' });
  assert.equal(r.queries.length, 2);
  assert.match(r.queries[1], /composition/);
});

test('step-back: abstract equal to original is not duplicated', async () => {
  const openai = scripted([
    JSON.stringify({ stepBack: 'same question' }),
  ]);
  const r = await qt.stepBack({ openai, query: 'same question' });
  assert.equal(r.queries.length, 1);
});

// ─── Decompose ───────────────────────────────────────────────────────────

test('decompose: splits into sub-questions + keeps original', async () => {
  const openai = scripted([
    JSON.stringify({ subQuestions: ['When was it built?', 'Who designed it?'] }),
  ]);
  const r = await qt.decompose({ openai, query: 'When was the Eiffel Tower built and who designed it?' });
  assert.equal(r.queries.length, 3);
  assert.equal(r.queries[0], 'When was the Eiffel Tower built and who designed it?');
  assert.match(r.queries[1], /built/);
  assert.match(r.queries[2], /designed/);
});

test('decompose: caps at maxSubQuestions', async () => {
  const openai = scripted([
    JSON.stringify({ subQuestions: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] }),
  ]);
  const r = await qt.decompose({ openai, query: 'big question', maxSubQuestions: 2 });
  assert.equal(r.trace.subQuestions.length, 2);
  assert.equal(r.queries.length, 3); // original + 2 subs
});

test('decompose: dedupes case-insensitively', async () => {
  const openai = scripted([
    JSON.stringify({ subQuestions: ['What is x?', 'what is X?'] }),
  ]);
  const r = await qt.decompose({ openai, query: 'What is x?' });
  // "what is x?" + 2 subs (one dup) → 1 unique remains after dedupe
  assert.equal(r.queries.length, 1);
});

// ─── Dispatcher ──────────────────────────────────────────────────────────

test('transform: dispatches to correct strategy', async () => {
  const openai = scripted([JSON.stringify({ passage: 'p' })]);
  const r = await qt.transform({ openai, query: 'q', strategy: 'hyde' });
  assert.equal(r.trace.strategy, 'hyde');
});

test('transform: unknown strategy rejected', async () => {
  await assert.rejects(
    qt.transform({ openai: scripted([]), query: 'q', strategy: 'star-trek' }),
    /unknown strategy/,
  );
});
