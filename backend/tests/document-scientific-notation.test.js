'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-scientific-notation');
const { extractScientificNotation, buildScientificNotationForFiles, renderScientificNotationBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractScientificNotation('').total, 0);
  assert.equal(extractScientificNotation(null).total, 0);
});

test('detects E-notation 1.5e10', () => {
  const r = extractScientificNotation('Avogadro 6.022e23 particles.');
  assert.ok(r.entries.some((e) => e.kind === 'e-notation'));
});

test('detects negative exponent 1.23e-7', () => {
  const r = extractScientificNotation('Probability 1.23e-7 estimated.');
  assert.ok(r.entries.some((e) => /1\.23e-7/i.test(e.value)));
});

test('detects capital E 9.81E+2', () => {
  const r = extractScientificNotation('Force at 9.81E+2 newtons.');
  assert.ok(r.entries.some((e) => e.kind === 'e-notation'));
});

test('detects × 10 notation with caret', () => {
  const r = extractScientificNotation('Avogadro 6.022 × 10^23 particles.');
  assert.ok(r.entries.some((e) => e.kind === 'times-notation'));
});

test('detects x 10 notation', () => {
  const r = extractScientificNotation('Mass 9.1 x 10^-31 kg electron.');
  assert.ok(r.entries.some((e) => e.kind === 'times-notation'));
});

test('detects bare superscript 10⁶', () => {
  const r = extractScientificNotation('10⁶ Hz frequency.');
  assert.ok(r.entries.some((e) => e.kind === 'superscript'));
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${i}.5e${i + 2} `;
  const r = extractScientificNotation(text);
  assert.ok(r.entries.length <= 20);
});

test('dedupes identical entries', () => {
  const r = extractScientificNotation('Value 1.5e10. Compare 1.5e10.');
  assert.equal(r.entries.filter((e) => /1\.5e10/i.test(e.value)).length, 1);
});

test('buildScientificNotationForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '6.022e23' },
    { name: 'b.md', extractedText: '1.23e-7' },
  ];
  const r = buildScientificNotationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderScientificNotationBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '6.022e23' }];
  const r = buildScientificNotationForFiles(files);
  const md = renderScientificNotationBlock(r);
  assert.match(md, /^## SCIENTIFIC NOTATION/);
});

test('renderScientificNotationBlock empty when nothing surfaces', () => {
  assert.equal(renderScientificNotationBlock({ perFile: [] }), '');
  assert.equal(renderScientificNotationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildScientificNotationForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '6.022e23' },
  ]);
  assert.equal(r.perFile.length, 1);
});
