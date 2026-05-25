'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runParaphrasePipeline,
  jaccardSimilarity,
  resolveMaxSimilarity,
  normaliseMode,
  MODE_SIMILARITY_CEILINGS,
  MODE_ALIASES,
} = require('../src/services/paraphrase-engine');

test('jaccardSimilarity detects overlap', () => {
  assert.ok(jaccardSimilarity('hello world foo', 'hello world bar') > 0.3);
});

test('paraphrase pipeline rejects overly similar output', async () => {
  const source = 'The quick brown fox jumps over the lazy dog repeatedly.';
  const result = await runParaphrasePipeline({
    source,
    mode: 'standard',
    rewriteFn: async () => source,
    maxSimilarity: 0.5,
  });
  assert.equal(result.ok, false);
  assert.ok(result.similarity > 0.5);
});

test('paraphrase pipeline accepts rewritten output', async () => {
  const result = await runParaphrasePipeline({
    source: 'Alpha beta gamma delta epsilon zeta.',
    mode: 'standard',
    rewriteFn: async ({ text }) => `Rewritten: ${text.split(' ').reverse().join(' ')}`,
    maxSimilarity: 0.95,
  });
  assert.equal(result.ok, true);
  assert.ok(result.output.length > 0);
});

test('MODE_SIMILARITY_CEILINGS: humanize/creative are stricter than standard', () => {
  assert.ok(MODE_SIMILARITY_CEILINGS.humanize < MODE_SIMILARITY_CEILINGS.standard);
  assert.ok(MODE_SIMILARITY_CEILINGS.creative < MODE_SIMILARITY_CEILINGS.standard);
  assert.ok(MODE_SIMILARITY_CEILINGS.academic < MODE_SIMILARITY_CEILINGS.standard);
  assert.equal(MODE_SIMILARITY_CEILINGS.humanize, 0.55);
});

test('resolveMaxSimilarity: explicit value wins over the mode ceiling', () => {
  assert.equal(resolveMaxSimilarity('humanize', 0.9), 0.9);
  assert.equal(resolveMaxSimilarity('standard', 0.4), 0.4);
});

test('resolveMaxSimilarity: invalid explicit values fall back to the mode ceiling', () => {
  assert.equal(resolveMaxSimilarity('humanize', 0), 0.55);
  assert.equal(resolveMaxSimilarity('humanize', -1), 0.55);
  assert.equal(resolveMaxSimilarity('humanize', 2), 0.55);
  assert.equal(resolveMaxSimilarity('humanize', NaN), 0.55);
  assert.equal(resolveMaxSimilarity('humanize'), 0.55);
});

test('normaliseMode: known aliases resolve to the canonical key', () => {
  assert.equal(normaliseMode('human'), 'humanize');
  assert.equal(normaliseMode('humanise'), 'humanize');
  assert.equal(normaliseMode('paraphrase'), 'standard');
  assert.equal(normaliseMode('formalize'), 'formal');
  assert.equal(normaliseMode('academic-style'), 'academic');
  assert.equal(normaliseMode('scholarly'), 'academic');
  assert.equal(normaliseMode('short'), 'shorten');
  assert.equal(normaliseMode('shorter'), 'shorten');
  assert.equal(normaliseMode('expanded'), 'expand');
  assert.equal(normaliseMode('longer'), 'expand');
  assert.equal(normaliseMode('simplify'), 'simple');
});

test('normaliseMode: case-insensitive + trims whitespace', () => {
  assert.equal(normaliseMode('  HUMAN  '), 'humanize');
  assert.equal(normaliseMode('Academic-Style'), 'academic');
});

test('normaliseMode: unknown mode passes through unchanged (lowercase)', () => {
  assert.equal(normaliseMode('weird'), 'weird');
  assert.equal(normaliseMode(''), '');
});

test('resolveMaxSimilarity: applies aliases — "human" → humanize ceiling', () => {
  assert.equal(resolveMaxSimilarity('human'), 0.55);
  assert.equal(resolveMaxSimilarity('humanize'), 0.55);
  assert.equal(resolveMaxSimilarity('paraphrase'), 0.72); // → standard
  assert.equal(resolveMaxSimilarity('shorter'), 0.78);    // → shorten
});

test('resolveMaxSimilarity: unknown modes fall back to standard (0.72)', () => {
  assert.equal(resolveMaxSimilarity('weird_unknown_mode'), 0.72);
  assert.equal(resolveMaxSimilarity(''), 0.72);
  assert.equal(resolveMaxSimilarity(null), 0.72);
});

test('runParaphrasePipeline: humanize mode reports the stricter ceiling on the response', async () => {
  const result = await runParaphrasePipeline({
    source: 'Alpha beta gamma delta epsilon zeta.',
    mode: 'humanize',
    rewriteFn: async ({ text }) => `Different: ${text.split(' ').reverse().join(' ')}`,
  });
  assert.equal(result.maxSimilarity, 0.55, 'humanize ceiling should leak to the caller');
});

test('runParaphrasePipeline: caller-supplied maxSimilarity wins over the mode default', async () => {
  const result = await runParaphrasePipeline({
    source: 'Alpha beta gamma delta epsilon zeta.',
    mode: 'humanize',
    rewriteFn: async ({ text }) => `Different: ${text.split(' ').reverse().join(' ')}`,
    maxSimilarity: 0.9,
  });
  assert.equal(result.maxSimilarity, 0.9, 'explicit caller value must win');
});
