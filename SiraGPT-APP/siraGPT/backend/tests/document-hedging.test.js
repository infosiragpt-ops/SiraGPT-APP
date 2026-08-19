'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-hedging');
const { extractHedging, buildHedgingForFiles, renderHedgingBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractHedging('').total, 0);
  assert.equal(extractHedging(null).total, 0);
});

test('detects "perhaps"', () => {
  const r = extractHedging('Perhaps the results are biased.');
  assert.ok(r.entries.some((e) => /perhaps/.test(e.phrase)));
});

test('detects "possibly"', () => {
  const r = extractHedging('Possibly the wrong choice for our use case.');
  assert.ok(r.entries.some((e) => /possibly/.test(e.phrase)));
});

test('detects "appears to"', () => {
  const r = extractHedging('The system appears to be stable.');
  assert.ok(r.entries.some((e) => /appears to/.test(e.phrase)));
});

test('detects "seems to"', () => {
  const r = extractHedging('It seems to work in production.');
  assert.ok(r.entries.some((e) => /seems to/.test(e.phrase)));
});

test('detects Spanish "quizás"', () => {
  const r = extractHedging('Quizás los resultados están sesgados.');
  assert.ok(r.entries.some((e) => /quiz[áa]s/.test(e.phrase)));
});

test('detects Spanish "aparentemente"', () => {
  const r = extractHedging('Aparentemente, todo funciona bien.');
  assert.ok(r.entries.some((e) => /aparentemente/.test(e.phrase)));
});

test('detects "tal vez"', () => {
  const r = extractHedging('Tal vez deberíamos esperar.');
  assert.ok(r.entries.some((e) => /tal vez/.test(e.phrase)));
});

test('reports density per 1000 words', () => {
  const text = ('perhaps ' + 'word '.repeat(99));
  const r = extractHedging(text);
  assert.ok(r.density > 0);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Perhaps item ${i} word${i}. `;
  const r = extractHedging(text);
  assert.ok(r.entries.length <= 20);
});

test('buildHedgingForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Perhaps yes.' },
    { name: 'b.md', extractedText: 'Possibly no.' },
  ];
  const r = buildHedgingForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHedgingBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Perhaps it works.' }];
  const r = buildHedgingForFiles(files);
  const md = renderHedgingBlock(r);
  assert.match(md, /^## HEDGING LANGUAGE/);
});

test('renderHedgingBlock empty when nothing surfaces', () => {
  assert.equal(renderHedgingBlock({ perFile: [] }), '');
  assert.equal(renderHedgingBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHedgingForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Perhaps it works.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
