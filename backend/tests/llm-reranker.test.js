/**
 * Unit tests for services/llm-reranker.js.
 * Focused on pure helpers (buildPrompt, parseResponse, cacheKey) and the
 * skip paths in rerank(); the LLM call itself is stubbed so tests stay
 * offline and deterministic.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rerank,
  clearCache,
  buildPrompt,
  parseResponse,
  cacheKey,
  DEFAULT_CONFIG,
} = require('../src/services/llm-reranker');

test('buildPrompt includes query and all passages numbered 1..N', () => {
  const prompt = buildPrompt('what is pricing?', [
    { text: 'pricing is $10/month' },
    { text: 'refunds within 30 days' },
    { text: 'annual plan saves 20%' },
  ], 400);
  assert.ok(prompt.includes('what is pricing?'));
  assert.ok(prompt.includes('[1]'));
  assert.ok(prompt.includes('[2]'));
  assert.ok(prompt.includes('[3]'));
  assert.ok(prompt.includes('pricing is $10/month'));
});

test('buildPrompt truncates long passages to snippetMax', () => {
  const long = 'x'.repeat(1000);
  const prompt = buildPrompt('q', [{ text: long }], 50);
  // The passage body should contain exactly snippetMax consecutive x's —
  // other x's in the surrounding prompt template ("text", "exactly") must
  // not inflate the count, so we match the run rather than the letter.
  const run = prompt.match(/x{2,}/);
  assert.ok(run, 'expected a run of x characters in the prompt');
  assert.equal(run[0].length, 50);
});

test('parseResponse extracts scored rankings from clean JSON', () => {
  const raw = JSON.stringify({
    rankings: [
      { passage_number: 1, score: 0.9 },
      { passage_number: 2, score: 0.3 },
    ],
  });
  const scores = parseResponse(raw, 2);
  assert.equal(scores.get(0), 0.9);
  assert.equal(scores.get(1), 0.3);
});

test('parseResponse clamps scores into [0,1]', () => {
  const raw = JSON.stringify({
    rankings: [
      { passage_number: 1, score: 5 },      // clamp high
      { passage_number: 2, score: -0.5 },   // clamp low
    ],
  });
  const scores = parseResponse(raw, 2);
  assert.equal(scores.get(0), 1);
  assert.equal(scores.get(1), 0);
});

test('parseResponse ignores out-of-range passage numbers', () => {
  const raw = JSON.stringify({
    rankings: [
      { passage_number: 99, score: 0.8 },
      { passage_number: 0, score: 0.5 },
      { passage_number: 1, score: 0.6 },
    ],
  });
  const scores = parseResponse(raw, 2);
  assert.equal(scores.size, 1);
  assert.equal(scores.get(0), 0.6);
});

test('parseResponse recovers JSON from text with leading chatter', () => {
  const raw = 'Sure, here you go:\n{"rankings":[{"passage_number":1,"score":0.7}]}\nHope that helps!';
  const scores = parseResponse(raw, 1);
  assert.equal(scores.get(0), 0.7);
});

test('parseResponse returns empty Map for garbage input', () => {
  assert.equal(parseResponse('', 3).size, 0);
  assert.equal(parseResponse('not json at all', 3).size, 0);
});

test('cacheKey is deterministic and order-insensitive on ids', () => {
  const a = cacheKey('q', ['a', 'b', 'c']);
  const b = cacheKey('q', ['c', 'b', 'a']);
  assert.equal(a, b);
});

test('cacheKey changes with query', () => {
  const a = cacheKey('q1', ['a']);
  const b = cacheKey('q2', ['a']);
  assert.notEqual(a, b);
});

test('rerank: empty candidates returns empty array', async () => {
  const out = await rerank(null, 'q', []);
  assert.deepEqual(out, []);
});

test('rerank: fewer than minChunksToRerank falls back to cosine order', async () => {
  const candidates = [
    { text: 'a', score: 0.3 },
    { text: 'b', score: 0.9 },
  ];
  const out = await rerank(null, 'q', candidates);
  assert.deepEqual(out.map(c => c.text), ['b', 'a']);
});

test('rerank: null openai client skips LLM call and returns cosine order', async () => {
  const candidates = [
    { text: 'a', score: 0.3 },
    { text: 'b', score: 0.9 },
    { text: 'c', score: 0.5 },
  ];
  const out = await rerank(null, 'q', candidates);
  assert.deepEqual(out.map(c => c.text), ['b', 'c', 'a']);
});

test('rerank: uses stubbed LLM response to reorder', async () => {
  clearCache();
  // Stub: an OpenAI-shaped client whose completion returns fixed JSON.
  const fakeOpenAI = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                rankings: [
                  { passage_number: 1, score: 0.2 },
                  { passage_number: 2, score: 0.9 },
                  { passage_number: 3, score: 0.5 },
                ],
              }),
            },
          }],
        }),
      },
    },
  };
  const candidates = [
    { text: 'first-in-input',  score: 0.91 },
    { text: 'second-in-input', score: 0.80 },
    { text: 'third-in-input',  score: 0.75 },
  ];
  // Despite the original cosine ordering, the stub says #2 is most relevant.
  const out = await rerank(fakeOpenAI, 'q', candidates);
  assert.equal(out[0].text, 'second-in-input');
  assert.equal(out[1].text, 'third-in-input');
  assert.equal(out[2].text, 'first-in-input');
});

test('rerank: LLM failure falls back to cosine order without throwing', async () => {
  const brokenOpenAI = {
    chat: { completions: { create: async () => { throw new Error('boom'); } } },
  };
  const candidates = [
    { text: 'a', score: 0.3 },
    { text: 'b', score: 0.9 },
    { text: 'c', score: 0.5 },
  ];
  const out = await rerank(brokenOpenAI, 'unique-query-for-cache-miss', candidates);
  assert.deepEqual(out.map(c => c.text), ['b', 'c', 'a']);
});

test('DEFAULT_CONFIG has sensible defaults', () => {
  assert.ok(DEFAULT_CONFIG.minChunksToRerank >= 2);
  assert.ok(DEFAULT_CONFIG.cacheTtlMs > 0);
  assert.ok(DEFAULT_CONFIG.unrankedFallbackScore >= 0 && DEFAULT_CONFIG.unrankedFallbackScore <= 1);
});
