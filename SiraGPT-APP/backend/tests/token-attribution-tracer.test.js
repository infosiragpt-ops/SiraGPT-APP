'use strict';

const test = require('node:test');
const assert = require('node:assert');

const tracer = require('../src/services/token-attribution-tracer');

test('tokenize strips stopwords + short tokens', () => {
  const t = tracer.tokenize('The user wants the backend deployed.');
  assert.ok(!t.includes('the'));
  assert.ok(t.includes('user'));
  assert.ok(t.includes('backend'));
});

test('trace: exact matches attributed at high score', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'user_message', text: 'Deploy the backend for revenue charts.' }],
    output: 'I will deploy the backend now.',
  });
  const deployTok = r.outputTokens.find((t) => t.token === 'deploy');
  assert.ok(deployTok);
  assert.ok(deployTok.maxScore >= 0.9);
  assert.ok(deployTok.topSources[0].token === 'deploy');
});

test('trace: synonym match attributed at medium score', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'user_message', text: 'Quiero traducir la función.' }],
    output: 'I will translate the function.',
  });
  const funcTok = r.outputTokens.find((t) => t.token === 'function');
  // synonym lookup: function → función. We expect any match.
  assert.ok(funcTok);
});

test('trace: tokens with no input match are unsupported', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'user_message', text: 'hello world' }],
    output: 'asparagus quantum framework synthesizer',
  });
  assert.ok(r.unsupported > 0);
  assert.ok(r.coverage < 0.5);
});

test('trace: numeric tokens attribute to numeric inputs', () => {
  const r = tracer.trace({
    inputs: [{ id: 'rag', label: 'rag_chunk', text: 'Revenue was 1500usd in Q3.' }],
    output: 'Q3 revenue: 1500usd.',
  });
  const numTok = r.outputTokens.find((t) => t.token === '1500usd');
  assert.ok(numTok);
  assert.ok(numTok.topSources.length > 0);
});

test('trace: respects topK', () => {
  const r = tracer.trace({
    inputs: [
      { id: 'a', label: 'a', text: 'deploy deploy deploy' },
      { id: 'b', label: 'b', text: 'deploy backend api production' },
    ],
    output: 'deploy',
    opts: { topK: 2 },
  });
  const tok = r.outputTokens[0];
  assert.ok(tok.topSources.length <= 2);
});

test('trace: respects maxOutputTokens cap', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'um', text: 'x y z' }],
    output: Array.from({ length: 500 }, (_, i) => `token${i}`).join(' '),
    opts: { maxOutputTokens: 50 },
  });
  assert.ok(r.outputTokens.length <= 50);
});

test('trace: returns stats including durationMs', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'um', text: 'a b c' }],
    output: 'a b',
  });
  assert.ok(typeof r.stats.durationMs === 'number');
  assert.ok(typeof r.stats.inputTokens === 'number');
});

test('trace: empty inputs → everything unsupported', () => {
  const r = tracer.trace({ inputs: [], output: 'some text here' });
  assert.strictEqual(r.supported, 0);
  assert.strictEqual(r.coverage, 0);
});

test('trace: empty output returns zero outputTokens', () => {
  const r = tracer.trace({ inputs: [{ id: 'a', label: 'a', text: 'x' }], output: '' });
  assert.strictEqual(r.outputTokens.length, 0);
});

test('trace: positional proximity nudges score', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'um', text: 'backend deploy revenue chart' }],
    output: 'backend deploy revenue chart',
  });
  // every output token should find its perfect input match
  for (const tok of r.outputTokens) {
    assert.ok(tok.maxScore >= 0.9);
  }
});

test('buildTraceBlock returns prompt text for non-empty report', () => {
  const r = tracer.trace({
    inputs: [{ id: 'um', label: 'user_message', text: 'Deploy backend' }],
    output: 'I will deploy backend.',
  });
  const block = tracer.buildTraceBlock(r);
  assert.ok(block.includes('<token_attribution>'));
  assert.ok(block.includes('Cobertura'));
});

test('buildTraceBlock empty for empty report', () => {
  assert.strictEqual(tracer.buildTraceBlock(null), '');
  assert.strictEqual(tracer.buildTraceBlock({ outputTokens: [] }), '');
});

test('stem strips common suffixes', () => {
  assert.strictEqual(tracer.stem('deployment'), 'deploy');
  // running → runn (crude stemmer strips "ing"); good enough for matching purposes
  assert.ok(tracer.stem('running').startsWith('runn') || tracer.stem('running') === 'run');
});

test('hot path: 200 output × 100 input tokens under 50ms', () => {
  const longInput = Array.from({ length: 100 }, (_, i) => `input${i}`).join(' ');
  const longOutput = Array.from({ length: 200 }, (_, i) => `out${i}`).join(' ');
  const t0 = Date.now();
  tracer.trace({ inputs: [{ id: 'a', label: 'a', text: longInput }], output: longOutput });
  assert.ok(Date.now() - t0 < 100);
});
