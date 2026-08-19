'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-chemistry');
const { extractChemistry, buildChemistryForFiles, renderChemistryBlock, _internal } = engine;
const { looksLikeFormula } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractChemistry('').total, 0);
  assert.equal(extractChemistry(null).total, 0);
});

test('looksLikeFormula: valid forms', () => {
  assert.equal(looksLikeFormula('H2O'), true);
  assert.equal(looksLikeFormula('CO2'), true);
  assert.equal(looksLikeFormula('C6H12O6'), true);
  assert.equal(looksLikeFormula('PhD'), false);
  assert.equal(looksLikeFormula('hello'), false);
});

test('detects H2O', () => {
  const r = extractChemistry('Water is H2O.');
  assert.ok(r.entries.some((e) => e.value === 'H2O'));
});

test('detects CO2', () => {
  const r = extractChemistry('Emissions of CO2 rising.');
  assert.ok(r.entries.some((e) => e.value === 'CO2'));
});

test('detects NaCl', () => {
  const r = extractChemistry('Table salt is NaCl crystalline.');
  assert.ok(r.entries.some((e) => e.value === 'NaCl'));
});

test('detects C6H12O6 (glucose)', () => {
  const r = extractChemistry('Glucose C6H12O6 in blood.');
  assert.ok(r.entries.some((e) => e.value === 'C6H12O6'));
});

test('detects element name "Hydrogen"', () => {
  const r = extractChemistry('Hydrogen is the lightest element.');
  assert.ok(r.entries.some((e) => e.value === 'Hydrogen'));
});

test('detects "Iron"', () => {
  const r = extractChemistry('Iron is magnetic.');
  assert.ok(r.entries.some((e) => e.value === 'Iron'));
});

test('rejects PhD as formula', () => {
  const r = extractChemistry('She has a PhD in chemistry.');
  assert.equal(r.entries.filter((e) => e.value === 'PhD').length, 0);
});

test('rejects MBA / API abbreviations', () => {
  const r = extractChemistry('Visit our API or use MBA program.');
  assert.equal(r.entries.filter((e) => /MBA|API/.test(e.value)).length, 0);
});

test('dedupes identical entries', () => {
  const r = extractChemistry('H2O once and H2O twice.');
  assert.equal(r.entries.filter((e) => e.value === 'H2O').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `H${i}O${i + 1} `;
  const r = extractChemistry(text);
  assert.ok(r.entries.length <= 20);
});

test('buildChemistryForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'H2O' },
    { name: 'b.md', extractedText: 'CO2' },
  ];
  const r = buildChemistryForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderChemistryBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'H2O' }];
  const r = buildChemistryForFiles(files);
  const md = renderChemistryBlock(r);
  assert.match(md, /^## CHEMISTRY/);
});

test('renderChemistryBlock empty when nothing surfaces', () => {
  assert.equal(renderChemistryBlock({ perFile: [] }), '');
  assert.equal(renderChemistryBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildChemistryForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'H2O' },
  ]);
  assert.equal(r.perFile.length, 1);
});
