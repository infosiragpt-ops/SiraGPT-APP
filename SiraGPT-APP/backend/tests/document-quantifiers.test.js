'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-quantifiers');
const { extractQuantifiers, buildQuantifiersForFiles, renderQuantifiersBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractQuantifiers('').total, 0);
  assert.equal(extractQuantifiers(null).total, 0);
});

test('detects universal quantifier "all"', () => {
  const r = extractQuantifiers('All users must consent before access.');
  assert.ok(r.entries.some((e) => e.kind === 'universal' && e.word === 'all'));
});

test('detects universal "every"', () => {
  const r = extractQuantifiers('Every record gets a timestamp.');
  assert.ok(r.entries.some((e) => e.kind === 'universal'));
});

test('detects Spanish "todos"', () => {
  const r = extractQuantifiers('Todos los usuarios deben aceptar.');
  assert.ok(r.entries.some((e) => e.kind === 'universal'));
});

test('detects existential "some"', () => {
  const r = extractQuantifiers('Some users prefer dark mode.');
  assert.ok(r.entries.some((e) => e.kind === 'existential'));
});

test('detects "at least one"', () => {
  const r = extractQuantifiers('At least one approval is required.');
  assert.ok(r.entries.some((e) => e.kind === 'existential'));
});

test('detects negative "none"', () => {
  const r = extractQuantifiers('None of the records were affected.');
  assert.ok(r.entries.some((e) => e.kind === 'negative'));
});

test('detects Spanish "ningún"', () => {
  const r = extractQuantifiers('Ningún usuario tiene acceso.');
  assert.ok(r.entries.some((e) => e.kind === 'negative'));
});

test('detects cardinal "many"', () => {
  const r = extractQuantifiers('Many users reported issues.');
  assert.ok(r.entries.some((e) => e.kind === 'cardinal'));
});

test('detects "few" cardinal', () => {
  const r = extractQuantifiers('Few errors were logged.');
  assert.ok(r.entries.some((e) => e.kind === 'cardinal'));
});

test('counts byKind', () => {
  const r = extractQuantifiers('All users. Some admins. None broken. Many requests.');
  assert.ok(r.totals.universal >= 1);
  assert.ok(r.totals.existential >= 1);
  assert.ok(r.totals.negative >= 1);
  assert.ok(r.totals.cardinal >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `All users ${i}. `;
  const r = extractQuantifiers(text);
  assert.ok(r.entries.length <= 20);
});

test('buildQuantifiersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'All users consent' },
    { name: 'b.md', extractedText: 'Some users opt-out' },
  ];
  const r = buildQuantifiersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderQuantifiersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'All users must agree' }];
  const r = buildQuantifiersForFiles(files);
  const md = renderQuantifiersBlock(r);
  assert.match(md, /^## QUANTIFIERS/);
});

test('renderQuantifiersBlock empty when nothing surfaces', () => {
  assert.equal(renderQuantifiersBlock({ perFile: [] }), '');
  assert.equal(renderQuantifiersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildQuantifiersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'All users' },
  ]);
  assert.equal(r.perFile.length, 1);
});
