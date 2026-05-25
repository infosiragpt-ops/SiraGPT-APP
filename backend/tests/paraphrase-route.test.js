'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// We don't need a server here — just want to test the exported helpers
// and the schema construction.
const paraphraseRoute = require('../src/routes/paraphrase');

const {
  resolveMaxTextLength,
  MAX_TEXT_LENGTH,
  ParaphraseSchema,
  SUPPORTED_MODES,
  SUPPORTED_LANGUAGES,
  paraphraseCost,
} = paraphraseRoute;

test('SUPPORTED_MODES: matches the spec\'s 8 modes + custom', () => {
  assert.deepEqual(SUPPORTED_MODES.sort(), [
    'academic', 'creative', 'custom', 'expand', 'formal',
    'humanize', 'shorten', 'simple', 'standard',
  ].sort());
});

test('SUPPORTED_LANGUAGES: at least Spanish + English', () => {
  assert.ok(SUPPORTED_LANGUAGES.includes('es'));
  assert.ok(SUPPORTED_LANGUAGES.includes('en'));
});

test('resolveMaxTextLength: defaults to 20_000 when env is empty', () => {
  assert.equal(resolveMaxTextLength({}), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: null }), 20_000);
});

test('resolveMaxTextLength: respects valid positive integer overrides', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '8000' }), 8_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '50000' }), 50_000);
});

test('resolveMaxTextLength: clamps to the 100_000 hard upper bound', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '999999' }), 100_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '100001' }), 100_000);
});

test('resolveMaxTextLength: falls back to default on invalid / negative / garbage', () => {
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '-5' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '0' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: 'not-a-number' }), 20_000);
  assert.equal(resolveMaxTextLength({ PARAPHRASE_MAX_TEXT_LENGTH: '1.5' }), 1); // parseInt → 1, still positive
});

test('MAX_TEXT_LENGTH: snapshot equals resolver result for the current env', () => {
  // Whatever the env was at load time, the exported constant must match
  // a fresh call with the live process.env.
  assert.equal(MAX_TEXT_LENGTH, resolveMaxTextLength(process.env));
});

test('ParaphraseSchema: rejects empty text', () => {
  const r = ParaphraseSchema.safeParse({ text: '' });
  assert.equal(r.success, false);
});

test('ParaphraseSchema: rejects text over the cap', () => {
  const tooLong = 'a'.repeat(MAX_TEXT_LENGTH + 1);
  const r = ParaphraseSchema.safeParse({ text: tooLong });
  assert.equal(r.success, false);
});

test('ParaphraseSchema: accepts text at the cap', () => {
  const justRight = 'a'.repeat(MAX_TEXT_LENGTH);
  const r = ParaphraseSchema.safeParse({ text: justRight });
  assert.equal(r.success, true);
});

test('ParaphraseSchema: defaults mode → standard, language → es', () => {
  const r = ParaphraseSchema.safeParse({ text: 'hello' });
  assert.equal(r.success, true);
  assert.equal(r.data.mode, 'standard');
  assert.equal(r.data.language, 'es');
});

test('ParaphraseSchema: rejects an unknown mode', () => {
  const r = ParaphraseSchema.safeParse({ text: 'hello', mode: 'turbocharge' });
  assert.equal(r.success, false);
});

test('paraphraseCost: at least 1 credit', () => {
  assert.ok(paraphraseCost({ body: { text: '' } }) >= 1);
  assert.ok(paraphraseCost({ body: { text: 'a'.repeat(500) } }) >= 1);
});

test('paraphraseCost: ~1 credit per 1000 chars by default', () => {
  // ratio resolved from CREDITS_PARAPHRASE_PER_1K_CHARS at call time
  const prevRatio = process.env.CREDITS_PARAPHRASE_PER_1K_CHARS;
  delete process.env.CREDITS_PARAPHRASE_PER_1K_CHARS;
  try {
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(1000) } }), 1);
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(2500) } }), 3);
    assert.equal(paraphraseCost({ body: { text: 'a'.repeat(10_000) } }), 10);
  } finally {
    if (prevRatio !== undefined) process.env.CREDITS_PARAPHRASE_PER_1K_CHARS = prevRatio;
  }
});
