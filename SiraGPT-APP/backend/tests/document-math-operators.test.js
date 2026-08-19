'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-math-operators');
const { extractMathOperators, buildMathOperatorsForFiles, renderMathOperatorsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMathOperators('').total, 0);
  assert.equal(extractMathOperators(null).total, 0);
});

test('detects inequality ≠', () => {
  const r = extractMathOperators('Note that A ≠ B in this case.');
  assert.ok(r.entries.some((e) => e.symbol === '≠'));
});

test('detects ≤ and ≥', () => {
  const r = extractMathOperators('Constraints: x ≤ 10 and y ≥ 0');
  assert.ok(r.entries.some((e) => e.symbol === '≤'));
  assert.ok(r.entries.some((e) => e.symbol === '≥'));
});

test('detects set theory ∈ ∉', () => {
  const r = extractMathOperators('If x ∈ S but y ∉ S');
  assert.ok(r.entries.some((e) => e.symbol === '∈'));
  assert.ok(r.entries.some((e) => e.symbol === '∉'));
});

test('detects union ∪ and intersection ∩', () => {
  const r = extractMathOperators('A ∪ B and A ∩ B');
  assert.ok(r.entries.some((e) => e.symbol === '∪'));
  assert.ok(r.entries.some((e) => e.symbol === '∩'));
});

test('detects logic ∧ ∨ ¬', () => {
  const r = extractMathOperators('P ∧ Q ∨ ¬R');
  assert.ok(r.entries.some((e) => e.symbol === '∧'));
  assert.ok(r.entries.some((e) => e.symbol === '∨'));
  assert.ok(r.entries.some((e) => e.symbol === '¬'));
});

test('detects ∀ ∃', () => {
  const r = extractMathOperators('∀ x ∃ y such that y > x');
  assert.ok(r.entries.some((e) => e.symbol === '∀'));
  assert.ok(r.entries.some((e) => e.symbol === '∃'));
});

test('detects arrows', () => {
  const r = extractMathOperators('A → B and C ⇒ D');
  assert.ok(r.entries.some((e) => e.symbol === '→'));
  assert.ok(r.entries.some((e) => e.symbol === '⇒'));
});

test('detects ∞ and √', () => {
  const r = extractMathOperators('Limit at ∞ via √2');
  assert.ok(r.entries.some((e) => e.symbol === '∞'));
  assert.ok(r.entries.some((e) => e.symbol === '√'));
});

test('counts repeated occurrences in totals', () => {
  const r = extractMathOperators('A ≠ B and C ≠ D and E ≠ F');
  assert.equal(r.totals['not-equal'], 3);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${String.fromCharCode(65 + i % 26)} ≠ ${String.fromCharCode(97 + i % 26)} `;
  const r = extractMathOperators(text);
  assert.ok(r.entries.length <= 20);
});

test('buildMathOperatorsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'A ≠ B' },
    { name: 'b.md', extractedText: 'C ∈ S' },
  ];
  const r = buildMathOperatorsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMathOperatorsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'A ≠ B' }];
  const r = buildMathOperatorsForFiles(files);
  const md = renderMathOperatorsBlock(r);
  assert.match(md, /^## MATHEMATICAL/);
});

test('renderMathOperatorsBlock empty when nothing surfaces', () => {
  assert.equal(renderMathOperatorsBlock({ perFile: [] }), '');
  assert.equal(renderMathOperatorsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMathOperatorsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'A ≠ B' },
  ]);
  assert.equal(r.perFile.length, 1);
});
