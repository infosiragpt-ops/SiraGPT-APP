'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-assumptions');
const { extractAssumptions, buildAssumptionsForFiles, renderAssumptionsBlock, _internal } = engine;
const { isAssumption } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractAssumptions('').total, 0);
  assert.equal(extractAssumptions(null).total, 0);
});

test('isAssumption: English forms', () => {
  assert.ok(isAssumption('We assume the market will grow 10% per year.'));
  assert.ok(isAssumption('This analysis assumes constant exchange rates.'));
  assert.ok(isAssumption('Assumptions: market stability, no regulatory changes.'));
});

test('isAssumption: Spanish forms', () => {
  assert.ok(isAssumption('Asumimos que el mercado crece de forma sostenida.'));
  assert.ok(isAssumption('Se supone que las tasas se mantienen estables.'));
  assert.ok(isAssumption('Supuestos: estabilidad del mercado, ausencia de cambios regulatorios.'));
});

test('isAssumption: non-assumption rejected', () => {
  assert.ok(!isAssumption('The market grew 10% last year.'));
});

test('extracts English assumptions', () => {
  const text = 'We assume the market grows 10% per year. This analysis assumes constant exchange rates.';
  const r = extractAssumptions(text);
  assert.equal(r.total, 2);
});

test('extracts Spanish assumptions', () => {
  const text = 'Asumimos crecimiento del 10%. Se supone que las tasas son estables.';
  const r = extractAssumptions(text);
  assert.equal(r.total, 2);
});

test('dedupes identical sentences', () => {
  const text = 'We assume X. We assume X.';
  const r = extractAssumptions(text);
  assert.equal(r.total, 1);
});

test('caps assumptions per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `We assume condition ${i} holds throughout the projection. `;
  const r = extractAssumptions(text);
  assert.ok(r.assumptions.length <= 14);
});

test('buildAssumptionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'We assume X.' },
    { name: 'b.md', extractedText: 'Asumimos Y.' },
  ];
  const r = buildAssumptionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAssumptionsBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'We assume X.' }];
  const r = buildAssumptionsForFiles(files);
  const md = renderAssumptionsBlock(r);
  assert.match(md, /^## ASSUMPTIONS/);
});

test('renderAssumptionsBlock empty when nothing found', () => {
  assert.equal(renderAssumptionsBlock({ perFile: [] }), '');
  assert.equal(renderAssumptionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAssumptionsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'We assume X.' }]);
  assert.ok(Array.isArray(r.perFile));
});
