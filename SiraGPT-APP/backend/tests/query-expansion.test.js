/**
 * Unit tests for services/query-expansion.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  tokenize,
  extractKeywords,
  expandQuery,
} = require('../src/services/query-expansion');

test('tokenize splits on whitespace + punctuation', () => {
  assert.deepEqual(
    tokenize('Hello, world! How are you?'),
    ['hello', 'world', 'how', 'are', 'you'],
  );
});

test('extractKeywords drops English stop words', () => {
  const out = extractKeywords('What is the pricing plan for annual users?');
  assert.ok(!out.includes('what'));
  assert.ok(!out.includes('the'));
  assert.ok(!out.includes('for'));
  assert.ok(out.includes('pricing'));
  assert.ok(out.includes('plan'));
  assert.ok(out.includes('annual'));
  assert.ok(out.includes('users'));
});

test('extractKeywords drops Spanish stop words and fillers', () => {
  const out = extractKeywords('Oye, dime cuánto cuesta la suscripción anual por favor');
  assert.ok(!out.includes('oye'));
  assert.ok(!out.includes('dime'));
  assert.ok(!out.includes('la'));
  assert.ok(!out.includes('por'));
  assert.ok(!out.includes('favor'));
  assert.ok(out.includes('cuesta'));
  assert.ok(out.includes('suscripción'));
  assert.ok(out.includes('anual'));
});

test('extractKeywords dedupes repeats preserving first-occurrence order', () => {
  const out = extractKeywords('pricing pricing model pricing policy model');
  assert.deepEqual(out, ['pricing', 'model', 'policy']);
});

test('extractKeywords drops pure numbers and <3-char tokens', () => {
  const out = extractKeywords('page 12 section 3 plan details');
  assert.ok(!out.includes('12'));
  assert.ok(!out.includes('3'));
  assert.ok(out.includes('page'));
  assert.ok(out.includes('section'));
  assert.ok(out.includes('plan'));
  assert.ok(out.includes('details'));
});

test('expandQuery returns original + keywords concatenation', () => {
  const { original, keywords, expanded } = expandQuery('hey can you find the pricing plan?');
  assert.equal(original, 'hey can you find the pricing plan?');
  assert.ok(keywords.includes('pricing'));
  assert.ok(keywords.includes('plan'));
  assert.ok(expanded.startsWith(original));
  assert.ok(expanded.includes('pricing plan') || expanded.endsWith('plan'));
});

test('expandQuery falls back to original when no keywords survive', () => {
  // All stopwords / too-short tokens.
  const { original, keywords, expanded } = expandQuery('is it the?');
  assert.equal(keywords.length, 0);
  assert.equal(expanded, original);
});

test('expandQuery handles empty input gracefully', () => {
  const { original, keywords, expanded } = expandQuery('');
  assert.equal(original, '');
  assert.deepEqual(keywords, []);
  assert.equal(expanded, '');
});
