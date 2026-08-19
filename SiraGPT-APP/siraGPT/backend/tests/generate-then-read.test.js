/**
 * Tests for GENREAD (generate-then-read).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const gr = require('../src/services/rag/generate-then-read');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── generate ────────────────────────────────────────────────────────────

test('generate: returns N labelled synthetic passages', async () => {
  const openai = scripted([JSON.stringify({
    passages: [
      { title: 'History', text: 'The Eiffel Tower was completed in 1889.' },
      { title: 'Dimensions', text: 'The Eiffel Tower is about 330 meters tall.' },
    ],
  })]);
  const r = await gr.generate({ openai, query: 'facts about the Eiffel Tower', numPassages: 2 });
  assert.equal(r.passages.length, 2);
  assert.equal(r.passages[0].generated, true);
  assert.match(r.passages[0].source, /^generated:/);
  assert.equal(r.trace.returned, 2);
});

test('generate: caps at numPassages', async () => {
  const openai = scripted([JSON.stringify({
    passages: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, text: `fact ${i}` })),
  })]);
  const r = await gr.generate({ openai, query: 'q', numPassages: 3 });
  assert.equal(r.passages.length, 3);
});

test('generate: empty query → empty passages with error reason', async () => {
  const r = await gr.generate({ openai: scripted([]), query: '' });
  assert.equal(r.passages.length, 0);
  assert.match(r.trace.error, /empty query/);
});

test('generate: null openai → empty + reason', async () => {
  const r = await gr.generate({ openai: null, query: 'q' });
  assert.equal(r.passages.length, 0);
  assert.match(r.trace.error, /no LLM/);
});

test('generate: LLM error surfaces in trace', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('rate-limited'); } } },
  };
  const r = await gr.generate({ openai, query: 'q' });
  assert.equal(r.passages.length, 0);
  assert.match(r.trace.error, /rate-limited/);
});

test('generate: LLM returns empty passages (cannot help) → returned=0', async () => {
  const openai = scripted([JSON.stringify({ passages: [] })]);
  const r = await gr.generate({ openai, query: 'q' });
  assert.equal(r.passages.length, 0);
  assert.equal(r.trace.returned, 0);
});

// ─── blend: fallback mode ────────────────────────────────────────────────

test('blend(fallback): real hits sufficient → no LLM call', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('should not be called'); } } },
  };
  const real = [
    { source: 'r1', text: 'real 1' },
    { source: 'r2', text: 'real 2' },
  ];
  const r = await gr.blend({
    openai, query: 'q',
    retrievalResults: real,
    mode: 'fallback', minHits: 2,
  });
  assert.equal(r.generated, 0);
  assert.equal(r.real, 2);
  assert.equal(r.passages.length, 2);
});

test('blend(fallback): sparse retrieval → generates passages and appends', async () => {
  const openai = scripted([JSON.stringify({
    passages: [
      { title: 'a', text: 'synthetic one' },
      { title: 'b', text: 'synthetic two' },
    ],
  })]);
  const r = await gr.blend({
    openai, query: 'q',
    retrievalResults: [{ source: 'r1', text: 'only real' }],
    mode: 'fallback', minHits: 2, numPassages: 2,
  });
  assert.equal(r.generated, 2);
  assert.equal(r.passages.length, 3);
  assert.equal(r.passages[0].source, 'r1');
  assert.ok(r.passages.slice(1).every(p => p.generated));
});

// ─── blend: augment mode ─────────────────────────────────────────────────

test('blend(augment): fuses via RRF, generated contributes even when real has hits', async () => {
  const openai = scripted([JSON.stringify({
    passages: [{ title: 'aug', text: 'synthetic augment passage' }],
  })]);
  const r = await gr.blend({
    openai, query: 'q',
    retrievalResults: [
      { source: 'r1', text: 'real one' },
      { source: 'r2', text: 'real two' },
    ],
    mode: 'augment', numPassages: 1,
  });
  assert.equal(r.generated, 1);
  assert.equal(r.real, 2);
  // Fused pool has real + synthetic with score annotations.
  assert.equal(r.passages.length, 3);
  assert.ok(r.passages.every(p => typeof p.score === 'number'));
  // Highest-ranked real (rank 1) should lead, with synthetic in the mix.
  assert.equal(r.passages[0].source, 'r1');
});
