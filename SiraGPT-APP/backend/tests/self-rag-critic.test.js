/**
 * Tests for the standalone Self-RAG critic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const critic = require('../src/services/rag/self-rag-critic');

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

// ─── splitAnswerIntoSegments ─────────────────────────────────────────────

test('splitAnswerIntoSegments: splits on sentence boundaries', () => {
  const s = critic.splitAnswerIntoSegments('First. Second! Third?');
  assert.deepEqual(s, ['First.', 'Second!', 'Third?']);
});

test('splitAnswerIntoSegments: handles Spanish inverted punctuation', () => {
  const s = critic.splitAnswerIntoSegments('¡Hola! ¿Cómo estás? Bien.');
  assert.equal(s.length, 3);
});

test('splitAnswerIntoSegments: empty answer → []', () => {
  assert.deepEqual(critic.splitAnswerIntoSegments(''), []);
  assert.deepEqual(critic.splitAnswerIntoSegments(null), []);
});

// ─── rateRelevance / rateSupport / rateUtility atoms ─────────────────────

test('rateRelevance: parses isRel', async () => {
  const openai = scripted([JSON.stringify({ isRel: 'relevant', reason: 'matches' })]);
  const r = await critic.rateRelevance({
    openai, model: 'x',
    question: 'q',
    passage: { text: 'p' },
  });
  assert.equal(r.isRel, 'relevant');
});

test('rateSupport: cited is clamped to valid passage range', async () => {
  const openai = scripted([JSON.stringify({
    isSup: 'fully_supported', cited: 99, reason: '',
  })]);
  const r = await critic.rateSupport({
    openai, model: 'x',
    question: 'q', segment: 'A claim.',
    passages: [{ text: 'p1' }],
  });
  assert.equal(r.cited, 0);  // 99 > passages.length=1 → clamped to 0 (no citation)
});

test('rateSupport: valid cited references source', async () => {
  const openai = scripted([JSON.stringify({
    isSup: 'fully_supported', cited: 1, reason: 'cited passage 1',
  })]);
  const r = await critic.rateSupport({
    openai, model: 'x',
    question: 'q', segment: 'A claim.',
    passages: [{ source: 'paper-a', text: 'p1' }],
  });
  assert.equal(r.cited, 1);
  assert.equal(r.citedSource, 'paper-a');
});

test('rateUtility: clamps invalid isUse to 3', async () => {
  const openai = scripted([JSON.stringify({ isUse: 99, reason: '' })]);
  const r = await critic.rateUtility({ openai, model: 'x', question: 'q', answer: 'a' });
  assert.equal(r.isUse, 3);
});

// ─── critique (full) ─────────────────────────────────────────────────────

test('critique: produces per-passage + per-segment + overall grade', async () => {
  const openai = scripted([
    // 2 relevance calls (parallel)
    JSON.stringify({ isRel: 'relevant',   reason: '' }),
    JSON.stringify({ isRel: 'irrelevant', reason: '' }),
    // 2 segment support calls
    JSON.stringify({ isSup: 'fully_supported',     cited: 1, reason: '' }),
    JSON.stringify({ isSup: 'partially_supported', cited: 1, reason: '' }),
    // 1 utility call
    JSON.stringify({ isUse: 4, reason: '' }),
  ]);
  const r = await critic.critique({
    openai,
    question: 'When was X?',
    answer: 'X happened in 1889. Later events followed from that.',
    passages: [
      { source: 'p1', text: 'X happened in 1889.' },
      { source: 'p2', text: 'Unrelated.' },
    ],
  });
  assert.equal(r.perPassage.length, 2);
  assert.equal(r.perPassage[0].isRel, 'relevant');
  assert.equal(r.perPassage[1].isRel, 'irrelevant');
  assert.equal(r.perSegment.length, 2);
  assert.equal(r.perSegment[0].isSup, 'fully_supported');
  assert.equal(r.overall.isUse, 4);
  assert.equal(r.overall.fullySupported, 1);
  assert.equal(r.overall.partiallySupported, 1);
  assert.ok(r.overall.overallScore > 0 && r.overall.overallScore <= 1);
});

test('critique: empty answer short-circuits', async () => {
  const r = await critic.critique({
    openai: scripted([]),
    question: 'q',
    answer: '',
    passages: [],
  });
  assert.equal(r.perSegment.length, 0);
  assert.equal(r.overall.isUse, 1);
  assert.equal(r.overall.overallScore, 0);
});

test('critique: skipPassageRelevance avoids ISREL calls', async () => {
  const openai = scripted([
    // Only segment support + utility; no ISREL calls
    JSON.stringify({ isSup: 'fully_supported', cited: 1, reason: '' }),
    JSON.stringify({ isUse: 5, reason: '' }),
  ]);
  const r = await critic.critique({
    openai,
    question: 'q',
    answer: 'Statement.',
    passages: [{ source: 'p1', text: 'p' }],
    skipPassageRelevance: true,
  });
  // 1 segment call + 1 utility call → 2 total; no passage-relevance calls.
  assert.equal(openai.calls.length, 2);
  assert.equal(r.perPassage[0].reason, 'skipped');
});

test('critique: citations list excludes unsupported segments', async () => {
  const openai = scripted([
    JSON.stringify({ isRel: 'relevant', reason: '' }),
    JSON.stringify({ isSup: 'fully_supported', cited: 1, reason: '' }),
    JSON.stringify({ isSup: 'no_support',      cited: 0, reason: '' }),
    JSON.stringify({ isUse: 3, reason: '' }),
  ]);
  const r = await critic.critique({
    openai,
    question: 'q',
    answer: 'Grounded claim. Ungrounded claim.',
    passages: [{ source: 'p1', text: 'p' }],
  });
  assert.equal(r.citations.length, 1);
  assert.equal(r.citations[0].segmentIndex, 0);
});

test('critique: missing openai rejected', async () => {
  await assert.rejects(
    critic.critique({ openai: null, question: 'q', answer: 'a', passages: [] }),
    /openai required/,
  );
});

test('critique: missing question rejected', async () => {
  await assert.rejects(
    critic.critique({ openai: scripted([]), question: '', answer: 'a', passages: [] }),
    /question required/,
  );
});

test('critique: weights influence overallScore', async () => {
  // Same inputs, different weights → different overallScore.
  const build = () => scripted([
    JSON.stringify({ isRel: 'relevant', reason: '' }),
    JSON.stringify({ isSup: 'partially_supported', cited: 1, reason: '' }),
    JSON.stringify({ isUse: 5, reason: '' }),
  ]);
  const lowUse = await critic.critique({
    openai: build(),
    question: 'q', answer: 'Partial claim.',
    passages: [{ source: 'p', text: 'p' }],
    weights: { wRel: 1, wSup: 1, wUse: 0.1 },
  });
  const highUse = await critic.critique({
    openai: build(),
    question: 'q', answer: 'Partial claim.',
    passages: [{ source: 'p', text: 'p' }],
    weights: { wRel: 1, wSup: 1, wUse: 5 },
  });
  assert.ok(highUse.overall.overallScore > lowUse.overall.overallScore);
});

test('critique: all-zero weights yield a finite overallScore (no NaN divide-by-zero)', async () => {
  const openai = scripted([
    JSON.stringify({ isRel: 'relevant', reason: '' }),
    JSON.stringify({ isSup: 'fully_supported', cited: 1, reason: '' }),
    JSON.stringify({ isUse: 5, reason: '' }),
  ]);
  const r = await critic.critique({
    openai,
    question: 'q', answer: 'A claim.',
    passages: [{ source: 'p', text: 'p' }],
    weights: { wRel: 0, wSup: 0, wUse: 0 }, // denominator would be 0
  });
  assert.ok(Number.isFinite(r.overall.overallScore), `overallScore must be finite, got ${r.overall.overallScore}`);
  assert.equal(r.overall.overallScore, 0);
});
