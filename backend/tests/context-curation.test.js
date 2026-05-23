/**
 * Tests for Chain-of-Note + context compression.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'fake-key';

const cc = require('../src/services/rag/context-curation');

function scripted(seq) {
  let i = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: seq[Math.min(i++, seq.length - 1)] } }],
    }) } },
  };
}

// ─── sentenceRelevance / querySignalTerms ────────────────────────────────

test('querySignalTerms: drops stopwords + short tokens', () => {
  const s = cc.querySignalTerms('what is the capital of France and Germany?');
  assert.ok(s.has('capital'));
  assert.ok(s.has('france'));
  assert.ok(s.has('germany'));
  assert.ok(!s.has('is'));
  assert.ok(!s.has('of'));
  assert.ok(!s.has('the'));
});

test('querySignalTerms: handles Spanish stopwords', () => {
  const s = cc.querySignalTerms('¿cuál es la capital de Francia?');
  assert.ok(s.has('capital'));
  assert.ok(s.has('francia'));
  assert.ok(!s.has('de'));
  assert.ok(!s.has('la'));
});

test('sentenceRelevance: scores query-matching sentences higher', () => {
  const sig = cc.querySignalTerms('capital of France');
  const good = cc.sentenceRelevance('Paris is the capital of France.', sig);
  const bad = cc.sentenceRelevance('The weather today is nice.', sig);
  assert.ok(good > bad);
});

// ─── compress ────────────────────────────────────────────────────────────

test('compress: keeps top-N sentences per passage', () => {
  const passages = [{
    source: 'doc1',
    text: 'Paris is the capital of France. The Seine is a river in Paris. Cheese is popular across Europe. France is in Europe.',
  }];
  const out = cc.compress({
    query: 'capital of France',
    passages,
    topSentences: 2,
    minScore: 0,
  });
  assert.equal(out.compressed.length, 1);
  const kept = out.compressed[0].text;
  assert.ok(kept.includes('Paris is the capital of France'));
  // Should have dropped the off-topic cheese sentence.
  assert.ok(!kept.includes('Cheese'));
});

test('compress: neverEmpty=true keeps at least one sentence', () => {
  const passages = [{ source: 'x', text: 'This is unrelated text. Also unrelated.' }];
  const out = cc.compress({
    query: 'completely different topic',
    passages,
    minScore: 0.99,  // nothing will pass
    neverEmpty: true,
  });
  assert.ok(out.compressed[0].text.length > 0);
});

test('compress: neverEmpty=false allows empty output when nothing scores', () => {
  const passages = [{ source: 'x', text: 'This is unrelated text.' }];
  const out = cc.compress({
    query: 'completely different topic',
    passages,
    minScore: 0.99,
    neverEmpty: false,
  });
  assert.equal(out.compressed[0].text, '');
});

test('compress: totals report combined ratio', () => {
  const passages = [
    { source: 'a', text: 'Paris is the capital. Rome is another city. Off-topic.' },
    { source: 'b', text: 'France is in Europe. The sky is blue. Capital matters.' },
  ];
  const out = cc.compress({ query: 'capital', passages, topSentences: 2 });
  assert.ok(out.totals.compressedLen < out.totals.originalLen);
  assert.ok(out.totals.ratio < 1);
});

test('compress: empty passages list → zero output', () => {
  const out = cc.compress({ query: 'x', passages: [] });
  assert.deepEqual(out.compressed, []);
  assert.equal(out.totals.originalLen, 0);
});

// ─── chainOfNote ─────────────────────────────────────────────────────────

test('chainOfNote: keeps passages scored above threshold', async () => {
  const openai = scripted([
    JSON.stringify({ relevant: true, score: 0.8, note: 'matches the question directly' }),
    JSON.stringify({ relevant: false, score: 0.1, note: 'off-topic' }),
    JSON.stringify({ relevant: true, score: 0.5, note: 'partially relevant' }),
  ]);
  const passages = [
    { source: 'p1', text: 'answer passage' },
    { source: 'p2', text: 'unrelated' },
    { source: 'p3', text: 'partially useful' },
  ];
  const r = await cc.chainOfNote({ openai, query: 'q', passages, keepThreshold: 0.4 });
  assert.equal(r.kept.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].source, 'p2');
});

test('chainOfNote: LLM error keeps passage (fail-open)', async () => {
  const openai = {
    chat: { completions: { create: async () => { throw new Error('rate-limited'); } } },
  };
  const passages = [{ source: 'p', text: 'hello' }];
  const r = await cc.chainOfNote({ openai, query: 'q', passages });
  // Failure mode: passage is kept with a marker note.
  assert.equal(r.kept.length, 1);
  assert.match(r.notes[0].note, /note error/);
});

test('chainOfNote: empty query rejects all passages', async () => {
  const r = await cc.chainOfNote({ openai: scripted([]), query: '', passages: [{ source: 'a', text: 'b' }] });
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped.length, 1);
});
