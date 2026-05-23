'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runParaphrasePipeline, jaccardSimilarity } = require('../src/services/paraphrase-engine');

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
