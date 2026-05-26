/**
 * Tests for RECOMP abstractive compressor.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const ac = require('../src/services/rag/abstractive-compressor');

function scripted(content) {
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content } }],
    }) } },
  };
}

test('compress: returns summary + usedPassages references', async () => {
  const openai = scripted(JSON.stringify({
    summary: 'The Eiffel Tower was completed in 1889 and stands 330m tall.',
    used_passages: [1, 2],
    dropped_passages: [3],
  }));
  const passages = [
    { source: 'p1', text: 'The Eiffel Tower was completed in 1889.' },
    { source: 'p2', text: 'The Eiffel Tower is 330m tall.' },
    { source: 'p3', text: 'Paris is the capital of France.' },
  ];
  const r = await ac.compress({ openai, query: 'facts about the Eiffel Tower', passages });
  assert.match(r.summary, /1889.*330m/);
  assert.equal(r.usedPassages.length, 2);
  assert.deepEqual(r.usedPassages.map(u => u.source), ['p1', 'p2']);
  assert.equal(r.droppedPassages.length, 1);
  assert.equal(r.droppedPassages[0].source, 'p3');
});

test('compress: ratio tracks token reduction', async () => {
  const openai = scripted(JSON.stringify({
    summary: 'Short summary.',
    used_passages: [1], dropped_passages: [],
  }));
  const passages = [{ source: 'p', text: 'x'.repeat(2000) }];
  const r = await ac.compress({ openai, query: 'q', passages });
  assert.ok(r.summaryTokens < r.originalTokens);
  assert.ok(r.ratio < 0.5);
});

test('compress: empty passages returns zero-length', async () => {
  const r = await ac.compress({ openai: scripted('{}'), query: 'q', passages: [] });
  assert.equal(r.summary, '');
  assert.equal(r.originalTokens, 0);
});

test('compress: null openai → reason populated', async () => {
  const r = await ac.compress({
    openai: null, query: 'q',
    passages: [{ source: 'p', text: 'x' }],
  });
  assert.equal(r.summary, '');
  assert.equal(r.reason, 'no LLM client');
});

test('compress: LLM error → empty + reason', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('rate-limited'); } } },
  };
  const r = await ac.compress({
    openai, query: 'q',
    passages: [{ source: 'p', text: 'hi' }],
  });
  assert.equal(r.summary, '');
  assert.match(r.reason, /rate-limited/);
});

test('compress: out-of-range passage indices filtered', async () => {
  const openai = scripted(JSON.stringify({
    summary: 'fine',
    used_passages: [1, 5, 99], // only 1 exists
    dropped_passages: [],
  }));
  const passages = [{ source: 'p1', text: 'a' }];
  const r = await ac.compress({ openai, query: 'q', passages });
  assert.equal(r.usedPassages.length, 1);
  assert.equal(r.usedPassages[0].source, 'p1');
});
