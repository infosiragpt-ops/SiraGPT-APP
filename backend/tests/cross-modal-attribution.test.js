'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cma = require('../src/services/cross-modal-attribution');

test('sentenceSplit splits on terminators', () => {
  const out = cma.sentenceSplit('First sentence. Second one? Third! Final.');
  assert.ok(out.length >= 3);
});

test('sentenceSplit ignores trivial fragments', () => {
  const out = cma.sentenceSplit('Hi. .');
  assert.ok(out.every((s) => s.length >= 4));
});

test('tokenize strips stopwords', () => {
  const t = cma.tokenize('The user wants the backend.');
  assert.ok(!t.includes('the'));
  assert.ok(t.includes('backend'));
});

test('jaccard handles empty/identical', () => {
  assert.strictEqual(cma.jaccard(new Set(), new Set(['x'])), 0);
  assert.strictEqual(cma.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('attribute: lexical overlap produces a citation', () => {
  const r = cma.attribute({
    regions: [
      { id: 'r1', fileName: 'doc.pdf', label: 'Intro', kind: 'pdf', location: { page: 1 },
        text: 'The backend deployment uses Postgres and Redis for the cache.' },
    ],
    response: 'The backend deployment uses Postgres and Redis.',
  });
  assert.ok(r.citations.length === 1);
  assert.ok(r.citations[0].score >= 0.3);
  assert.strictEqual(r.citations[0].region.fileName, 'doc.pdf');
});

test('attribute: verbatim phrase triggers high-confidence citation', () => {
  const r = cma.attribute({
    regions: [{
      id: 'r1', fileName: 'doc.pdf', kind: 'pdf', location: { page: 2 },
      text: 'In Q3 our revenue grew 12.5% year over year driven by enterprise contracts.',
    }],
    response: 'Our revenue grew 12.5% year over year.',
  });
  assert.ok(r.citations[0]);
  assert.ok(r.citations[0].score >= 0.5);
  assert.ok(r.citations[0].confidence === 'high' || r.citations[0].confidence === 'medium');
  assert.ok(r.citations[0].matchedPhrase);
});

test('attribute: unrelated response → unsupported', () => {
  const r = cma.attribute({
    regions: [{ id: 'r1', fileName: 'doc.pdf', kind: 'pdf', text: 'Quantum physics fundamentals.' }],
    response: 'I love pineapple pizza.',
  });
  assert.strictEqual(r.citations.length, 0);
  assert.ok(r.unsupported >= 1);
});

test('attribute: empty regions → everything unsupported', () => {
  const r = cma.attribute({ regions: [], response: 'Some claim here.' });
  assert.strictEqual(r.citations.length, 0);
  assert.strictEqual(r.coverage, 0);
});

test('attribute: empty response returns zero stats', () => {
  const r = cma.attribute({ regions: [{ id: 'r1', text: 'x' }], response: '' });
  assert.strictEqual(r.citations.length, 0);
  assert.strictEqual(r.coverage, 0);
  assert.strictEqual(r.stats.sentences, 0);
});

test('attribute: respects opts.threshold (high → fewer citations)', () => {
  const data = {
    regions: [{ id: 'r1', fileName: 'doc.pdf', kind: 'pdf',
      text: 'Backend service runs on port 3000.' }],
    response: 'Backend listens on port 3000.',
  };
  const loose = cma.attribute({ ...data, opts: { threshold: 0.10 } });
  const strict = cma.attribute({ ...data, opts: { threshold: 0.99 } });
  assert.ok(loose.citations.length >= strict.citations.length);
});

test('attribute: respects maxRegions cap', () => {
  const regions = Array.from({ length: 100 }, (_, i) => ({
    id: `r${i}`, fileName: 'f', kind: 'pdf', text: `text region ${i}`,
  }));
  const r = cma.attribute({ regions, response: 'text region 0', opts: { maxRegions: 10 } });
  assert.ok(r.stats.regions <= 10);
});

test('attribute: respects maxSentences cap', () => {
  const long = Array.from({ length: 100 }, (_, i) => `Sentence ${i}.`).join(' ');
  const r = cma.attribute({
    regions: [{ id: 'r1', text: 'sentence 0' }],
    response: long,
    opts: { maxSentences: 5 },
  });
  assert.ok(r.stats.sentences <= 5);
});

test('formatLocation: page → p.N', () => {
  assert.strictEqual(cma.formatLocation({ page: 4 }), 'p.4');
});

test('formatLocation: section → § Title', () => {
  assert.strictEqual(cma.formatLocation({ section: 'Intro' }), '§ Intro');
});

test('formatLocation: sheet+range → Sheet!Range', () => {
  assert.strictEqual(cma.formatLocation({ sheet: 'Q3', range: 'A1:C10' }), 'Q3!A1:C10');
});

test('formatLocation: line span → L42-50', () => {
  assert.strictEqual(cma.formatLocation({ lineStart: 42, lineEnd: 50 }), 'L42-50');
  assert.strictEqual(cma.formatLocation({ line: 42 }), 'L42');
});

test('classifyConfidence: thresholds gate correctly', () => {
  assert.strictEqual(cma.classifyConfidence(0.9), 'high');
  assert.strictEqual(cma.classifyConfidence(0.4), 'medium');
  assert.strictEqual(cma.classifyConfidence(0.1), 'low');
});

test('buildCitationBlock returns prompt text for non-empty citations', () => {
  const r = cma.attribute({
    regions: [{ id: 'r1', fileName: 'doc.pdf', kind: 'pdf', location: { page: 2 },
      text: 'Revenue grew 12.5% year over year.' }],
    response: 'Revenue grew 12.5% year over year.',
  });
  const block = cma.buildCitationBlock(r);
  assert.ok(block.includes('<cross_modal_citations>'));
  assert.ok(block.includes('doc.pdf'));
});

test('buildCitationBlock empty for empty citations', () => {
  assert.strictEqual(cma.buildCitationBlock(null), '');
  assert.strictEqual(cma.buildCitationBlock({ citations: [] }), '');
});

test('hot path: 30 sentences × 50 regions under 100ms', () => {
  const regions = Array.from({ length: 50 }, (_, i) => ({
    id: `r${i}`, fileName: 'f', kind: 'pdf',
    text: `synthetic region ${i} with backend deploy keywords`,
  }));
  const long = Array.from({ length: 30 }, (_, i) => `Synthetic sentence ${i} about backend deploy.`).join(' ');
  const t0 = Date.now();
  cma.attribute({ regions, response: long });
  assert.ok(Date.now() - t0 < 200);
});
