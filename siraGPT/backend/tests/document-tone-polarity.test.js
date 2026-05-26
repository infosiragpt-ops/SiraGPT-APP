'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tone-polarity');
const { extractTonePolarity, buildTonePolarityForFiles, renderTonePolarityBlock, _internal } = engine;
const { classify } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTonePolarity('').classification, 'neutral');
  assert.equal(extractTonePolarity(null).classification, 'neutral');
});

test('classify: thresholds', () => {
  assert.equal(classify(0.5, 5, 1), 'positive');
  assert.equal(classify(-0.5, 1, 5), 'negative');
  assert.equal(classify(0, 0, 0), 'neutral');
});

test('detects positive tone', () => {
  const text = 'The new feature is excellent and great. We achieved success and gained efficiency. The system is reliable and powerful with strong benefits.'.repeat(2);
  const r = extractTonePolarity(text);
  assert.equal(r.classification, 'positive');
  assert.ok(r.score > 0);
});

test('detects negative tone', () => {
  const text = 'The system failed with multiple errors and bugs. Critical issues and severe problems. The deployment crashed and we suffered losses.'.repeat(2);
  const r = extractTonePolarity(text);
  assert.equal(r.classification, 'negative');
  assert.ok(r.score < 0);
});

test('detects neutral on plain text', () => {
  const text = 'The system processes the input and returns the output. Each step follows the next.'.repeat(3);
  const r = extractTonePolarity(text);
  assert.equal(r.classification, 'neutral');
});

test('detects Spanish positive', () => {
  const text = 'El sistema es excelente y eficiente. Es una mejora positiva con muchos beneficios. Recomiendo el cambio.'.repeat(2);
  const r = extractTonePolarity(text);
  assert.ok(r.posCount > 0);
});

test('detects Spanish negative', () => {
  const text = 'El sistema tiene un fracaso crítico con errores severos. Problemas serios de pérdidas y riesgos terribles.'.repeat(2);
  const r = extractTonePolarity(text);
  assert.ok(r.negCount > 0);
});

test('returns neutral when too few tokens', () => {
  const r = extractTonePolarity('Brief.');
  assert.equal(r.classification, 'neutral');
});

test('counts pos and neg separately', () => {
  const text = 'Great success with great improvements but had error and failure throughout the day across many phases.';
  const r = extractTonePolarity(text);
  assert.ok(r.posCount > 0);
  assert.ok(r.negCount > 0);
});

test('buildTonePolarityForFiles aggregates per file', () => {
  const positive = 'The new feature is excellent and great. We achieved success and gained efficiency.'.repeat(3);
  const negative = 'The system failed with multiple errors and bugs. Critical issues throughout.'.repeat(3);
  const files = [
    { name: 'a.md', extractedText: positive },
    { name: 'b.md', extractedText: negative },
  ];
  const r = buildTonePolarityForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTonePolarityBlock returns markdown when entries exist', () => {
  const text = 'The new feature is excellent and great. We achieved success and gained efficiency.'.repeat(3);
  const files = [{ name: 'doc.md', extractedText: text }];
  const r = buildTonePolarityForFiles(files);
  const md = renderTonePolarityBlock(r);
  assert.match(md, /^## TONE POLARITY/);
});

test('renderTonePolarityBlock empty when nothing surfaces', () => {
  assert.equal(renderTonePolarityBlock({ perFile: [] }), '');
  assert.equal(renderTonePolarityBlock(null), '');
});

test('handles non-string extractedText', () => {
  const text = 'The new feature is excellent and great. Success achieved.'.repeat(3);
  const r = buildTonePolarityForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: text },
  ]);
  assert.equal(r.perFile.length, 1);
});
