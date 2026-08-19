/**
 * Tests for citation precision/recall + str-em + fluency proxy.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const cm = require('../src/services/rag/citation-metrics');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── strEm ───────────────────────────────────────────────────────────────

test('strEm: single gold string match', () => {
  const r = cm.strEm('The answer is Paris.', 'Paris');
  assert.equal(r.match, true);
  assert.equal(r.matchedGold, 'Paris');
});

test('strEm: case + punctuation insensitive', () => {
  const r = cm.strEm('paris, france', 'Paris');
  assert.equal(r.match, true);
});

test('strEm: array of golds — any match wins', () => {
  const r = cm.strEm('We arrived in Tokyo.', ['Paris', 'Tokyo', 'London']);
  assert.equal(r.match, true);
  assert.equal(r.matchedGold, 'Tokyo');
});

test('strEm: no match', () => {
  const r = cm.strEm('We went to the park.', ['Paris', 'Tokyo']);
  assert.equal(r.match, false);
  assert.equal(r.matchedGold, null);
});

test('strEm: empty output → false', () => {
  assert.equal(cm.strEm('', 'x').match, false);
});

// ─── fluencyProxy ────────────────────────────────────────────────────────

test('fluencyProxy: identical candidate + reference → high score', () => {
  const ref = 'The Eiffel Tower was completed in 1889.';
  const r = cm.fluencyProxy(ref, ref);
  assert.ok(r.score > 0.9);
  assert.ok(r.bigramJaccard > 0.9);
});

test('fluencyProxy: disjoint → low score', () => {
  const r = cm.fluencyProxy('cats are small fluffy animals', 'the capital of France is Paris');
  assert.ok(r.score < 0.2);
});

test('fluencyProxy: shorter candidate penalised', () => {
  const ref = 'The capital of France is Paris, located on the Seine river in Europe.';
  const short = cm.fluencyProxy('Paris.', ref).score;
  const full  = cm.fluencyProxy(ref, ref).score;
  assert.ok(full > short);
});

test('fluencyProxy: empty candidate → 0', () => {
  const r = cm.fluencyProxy('', 'x y z');
  assert.equal(r.score, 0);
});

test('fluencyProxy: single-token candidate (no bigrams) → 0', () => {
  // candBi.size === 0 → the per-ref guard skips every reference → all-zero.
  const r = cm.fluencyProxy('token', 'token');
  assert.deepEqual(r, { score: 0, bigramJaccard: 0, lengthPenalty: 0 });
});

test('fluencyProxy: empty references array → 0', () => {
  const r = cm.fluencyProxy('a real multi word candidate', []);
  assert.deepEqual(r, { score: 0, bigramJaccard: 0, lengthPenalty: 0 });
});

// ─── citationPrecision ───────────────────────────────────────────────────

test('citationPrecision: mix of supported + unsupported citations', async () => {
  const openai = scripted([
    JSON.stringify({ supports: true,  reason: '' }),
    JSON.stringify({ supports: false, reason: '' }),
    JSON.stringify({ supports: true,  reason: '' }),
  ]);
  const r = await cm.citationPrecision({
    openai,
    citedClaims: [
      { segment: 'Claim 1', citedPassageText: 'pass 1' },
      { segment: 'Claim 2', citedPassageText: 'pass 2' },
      { segment: 'Claim 3', citedPassageText: 'pass 3' },
    ],
  });
  assert.equal(r.precision, 2 / 3);
  assert.equal(r.supported, 2);
  assert.equal(r.total, 3);
});

test('citationPrecision: empty citedClaims → precision=1', async () => {
  const r = await cm.citationPrecision({ openai: scripted([]), citedClaims: [] });
  assert.equal(r.precision, 1);
  assert.equal(r.total, 0);
});

// ─── citationRecall ──────────────────────────────────────────────────────

test('citationRecall: counts needs-citation vs has-citation per segment', async () => {
  const openai = scripted([
    // needsCitation per segment: two sentences; first is a fact, second is opinion.
    JSON.stringify({ needsCitation: true  }),
    JSON.stringify({ needsCitation: false }),
  ]);
  const r = await cm.citationRecall({
    openai,
    answer: 'The Eiffel Tower was built in 1889. I personally love it.',
    citedSegmentIndices: [0],
  });
  assert.equal(r.total, 1);     // only 1 segment needs a citation
  assert.equal(r.cited, 1);     // that one was cited
  assert.equal(r.recall, 1);
});

test('citationRecall: missing citation on a fact → recall < 1', async () => {
  const openai = scripted([
    JSON.stringify({ needsCitation: true }),
    JSON.stringify({ needsCitation: true }),
  ]);
  const r = await cm.citationRecall({
    openai,
    answer: 'Fact one happened. Fact two followed.',
    citedSegmentIndices: [0],  // only first is cited
  });
  assert.equal(r.total, 2);
  assert.equal(r.cited, 1);
  assert.equal(r.recall, 0.5);
});

test('citationRecall: empty answer → recall=1 (vacuously)', async () => {
  const r = await cm.citationRecall({ openai: scripted([]), answer: '', citedSegmentIndices: [] });
  assert.equal(r.recall, 1);
  assert.equal(r.total, 0);
});
