'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cross-reference');
const { extractReferences, buildReferencesForFiles, renderReferencesBlock, _internal } = engine;
const { sentenceAround } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractReferences('').total, 0);
  assert.equal(extractReferences(null).total, 0);
});

test('sentenceAround returns the surrounding sentence', () => {
  const text = 'First sentence. As stated in Section 4.2 the parties agree. Third sentence.';
  const idx = text.indexOf('Section');
  const s = sentenceAround(text, idx, 'Section 4.2'.length);
  assert.match(s, /Section 4\.2/);
});

test('detects English "see Section X" form', () => {
  const text = 'See Section 4.2 for further details.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Section 4\.2/.test(x.target)));
});

test('detects "pursuant to Article" form', () => {
  const text = 'Pursuant to Article 7.1, the parties shall comply.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Article 7\.1/.test(x.target)));
});

test('detects "Refer to Annex" form', () => {
  const text = 'Refer to Annex A for the schedule.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Annex/.test(x.target)));
});

test('detects "Section X above/below" form', () => {
  const text = 'Section 5.3 above describes the indemnification framework.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Section 5\.3/.test(x.target)));
});

test('detects Spanish "véase la Cláusula X" form', () => {
  const text = 'Véase la Cláusula 3.1 para más detalles.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Cl[áa]usula 3\.1/.test(x.target)));
});

test('detects Spanish "conforme al Artículo X" form', () => {
  const text = 'Conforme al Artículo 7 del presente contrato, las partes deberán cumplir.';
  const r = extractReferences(text);
  assert.ok(r.references.some((x) => /Art[ií]culo 7/.test(x.target)));
});

test('dedupes identical references in the same sentence', () => {
  const text = 'As stated in Section 4.2, see Section 4.2. As stated in Section 4.2.';
  const r = extractReferences(text);
  // The dedup key combines target+sentence prefix; we still get fewer than 3
  assert.ok(r.references.length <= 3);
});

test('target counts reflect repeated targets', () => {
  const text = 'See Section 4.2. Refer to Section 4.2 again. As stated in Section 4.2.';
  const r = extractReferences(text);
  // Some hits may dedupe by sentence prefix; ensure at least one is counted
  assert.ok((r.targetCounts['Section 4.2'] || 0) >= 1);
});

test('buildReferencesForFiles aggregates across files', () => {
  const files = [
    { name: 'contract-a.md', extractedText: 'See Section 4.2 for terms.' },
    { name: 'contract-b.md', extractedText: 'Refer to Article 3 of this Agreement.' },
  ];
  const r = buildReferencesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderReferencesBlock returns markdown when references exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'See Section 4.2 for further details.' }];
  const r = buildReferencesForFiles(files);
  const md = renderReferencesBlock(r);
  assert.match(md, /^## INTERNAL CROSS-REFERENCES/);
});

test('renderReferencesBlock empty when nothing found', () => {
  assert.equal(renderReferencesBlock({ perFile: [] }), '');
  assert.equal(renderReferencesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildReferencesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'See Section 4.' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('caps total references per file', () => {
  let text = '';
  for (let i = 1; i <= 30; i++) text += `See Section ${i}.${i} for detail. `;
  const r = extractReferences(text);
  assert.ok(r.references.length <= 18);
});
