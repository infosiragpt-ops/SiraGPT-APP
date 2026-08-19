/**
 * Tests for the answer engine (Perplexity/ChatGPT-search-style): passage
 * extraction, query planning, cited synthesis and end-to-end orchestration.
 * Fully hermetic — search/read/llm collaborators are injected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const passages = require('../src/services/answer/passage-extractor');
const planner = require('../src/services/answer/query-planner');
const synth = require('../src/services/answer/answer-synthesizer');
const engine = require('../src/services/answer/answer-engine');

// ── passage-extractor ────────────────────────────────────────────────

test('cleanText strips markdown + HTML to plain prose', () => {
  const out = passages.cleanText('# Title\n\n**Solar** energy is [clean](http://x). <b>Great</b>.');
  assert.ok(!/[#*<>[\]]/.test(out));
  assert.match(out, /Solar energy is clean/);
});

test('splitSentences keeps abbreviations intact', () => {
  const s = passages.splitSentences('Dr. Smith studied solar power. It works well.');
  assert.equal(s.length, 2);
  assert.match(s[0], /Dr\. Smith/);
});

test('extractPassages returns query-relevant sentences and drops the rest', () => {
  const text = 'Solar energy reduces electricity bills significantly. The weather was nice yesterday. Photovoltaic panels convert sunlight into solar electricity.';
  const out = passages.extractPassages(text, 'solar energy electricity', { maxPassages: 3 });
  assert.ok(out.length >= 1);
  assert.ok(out.every((p) => /solar|electricity|photovoltaic/i.test(p.text)));
  assert.ok(!out.some((p) => /weather was nice/i.test(p.text)));
});

test('extractPassages returns [] for a content-free query', () => {
  assert.deepEqual(passages.extractPassages('anything here today', '¿qué día es hoy?'), []);
});

// ── query-planner ────────────────────────────────────────────────────

test('plan always includes the original query', () => {
  const p = planner.plan('energía solar ventajas');
  assert.equal(p.subQueries[0], 'energía solar ventajas');
});

test('plan decomposes a comparison into both sides', () => {
  const p = planner.plan('React vs Vue para apps grandes');
  assert.equal(p.isComparison, true);
  const joined = p.subQueries.join(' | ').toLowerCase();
  assert.ok(joined.includes('react'));
  assert.ok(joined.includes('vue'));
});

test('plan detects multi-part questions', () => {
  const p = planner.plan('¿Qué es la fotosíntesis? ¿Dónde ocurre?');
  assert.equal(p.isMultiPart, true);
  assert.ok(p.subQueries.length >= 2);
});

// ── answer-synthesizer ───────────────────────────────────────────────

const SOURCES = [
  { title: 'Solar energy basics', url: 'https://a.example/solar', domain: 'a.example',
    snippet: 'Solar energy reduces electricity bills and cuts carbon emissions for homes.' },
  { title: 'Photovoltaics explained', url: 'https://b.example/pv', domain: 'b.example',
    snippet: 'Photovoltaic panels convert sunlight into solar electricity efficiently.' },
  { title: 'Unrelated cooking', url: 'https://c.example/food', domain: 'c.example',
    snippet: 'A recipe for pasta with cheese and tomato sauce.' },
];

test('synthesize builds a cited answer with numbered references', () => {
  const r = synth.synthesize('solar energy electricity', SOURCES);
  assert.match(r.answer, /\[1\]/);
  assert.ok(r.citations.length >= 1);
  assert.equal(r.citations[0].n, 1);
  assert.ok(r.citations.every((c) => /^https?:\/\//.test(c.url)));
  // the irrelevant cooking source should not be cited
  assert.ok(!r.citations.some((c) => /food/.test(c.url)));
  assert.ok(r.relatedQuestions.length >= 1);
  assert.ok(r.coverage > 0);
});

test('synthesize de-duplicates near-identical passages', () => {
  const dupes = [
    { title: 'A', url: 'https://a.example/1', snippet: 'Solar energy reduces electricity bills a lot.' },
    { title: 'B', url: 'https://b.example/2', snippet: 'Solar energy reduces electricity bills a lot.' },
  ];
  const r = synth.synthesize('solar energy electricity bills', dupes);
  // identical passages collapse, so the answer should not repeat the sentence.
  const occurrences = (r.answer.match(/reduces electricity bills/gi) || []).length;
  assert.ok(occurrences <= 1, `expected dedupe, saw ${occurrences}`);
});

// ── answer-engine (end-to-end, injected collaborators) ───────────────

function fakeSearch(results, providers = ['duckduckgo']) {
  return async () => ({ results, providers });
}

test('answer() returns a cited answer + stats from injected search', async () => {
  const searchFn = fakeSearch([
    { title: 'Solar energy basics', url: 'https://a.example/solar', snippet: 'Solar energy reduces electricity bills and emissions.' },
    { title: 'PV panels', url: 'https://b.example/pv', snippet: 'Photovoltaic panels convert sunlight into solar electricity.' },
    { title: 'Cooking', url: 'https://c.example/food', snippet: 'Pasta recipe with cheese.' },
  ]);
  const out = await engine.answer('ventajas de la energía solar', { searchFn });
  assert.ok(out.answer.length > 0);
  assert.match(out.answer, /\[\d+\]/);
  assert.ok(out.citations.length >= 1);
  assert.equal(out.mode, 'fast');
  assert.ok(out.stats.candidates >= 3);
  assert.ok(Array.isArray(out.stats.providers));
  assert.ok(Number.isFinite(out.stats.timings.total));
  assert.ok(out.relatedQuestions.length >= 1);
});

test('answer() deep mode reads top sources via injected readFn', async () => {
  const searchFn = fakeSearch([
    { title: 'Solar', url: 'https://a.example/solar', snippet: 'Solar energy overview.' },
  ]);
  let read = 0;
  const readFn = async (url) => { read += 1; return { content_markdown: 'Solar energy reduces electricity bills dramatically and lowers carbon emissions for households.', title: 'Solar deep' }; };
  const out = await engine.answer('energía solar electricidad emisiones', { mode: 'deep', searchFn, readFn });
  assert.equal(out.mode, 'deep');
  assert.ok(read >= 1, 'deep mode should read at least one source');
  assert.ok(out.sources.some((s) => s.read === true));
  assert.ok(out.stats.timings.read >= 0);
});

test('answer() uses a valid LLM rewrite but rejects invented citations', async () => {
  const searchFn = fakeSearch([
    { title: 'Solar', url: 'https://a.example/solar', snippet: 'Solar energy reduces electricity bills.' },
  ]);
  // valid rewrite (keeps [1])
  const good = await engine.answer('energía solar', { searchFn, llmFn: async () => 'La energía solar reduce las facturas eléctricas [1].' });
  assert.equal(good.stats.llmUsed, true);
  assert.match(good.answer, /facturas eléctricas \[1\]/);
  // invalid rewrite (invents [9]) → fall back to extractive
  const bad = await engine.answer('energía solar', { searchFn, llmFn: async () => 'Texto inventado con cita falsa [9].' });
  assert.equal(bad.stats.llmUsed, false);
});

test('answer() handles an empty query gracefully', async () => {
  const out = await engine.answer('   ', { searchFn: fakeSearch([]) });
  assert.equal(out.answer, '');
  assert.deepEqual(out.citations, []);
});
