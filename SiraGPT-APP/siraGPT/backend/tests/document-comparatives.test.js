'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-comparatives');
const { extractComparatives, buildComparativesForFiles, renderComparativesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractComparatives('').total, 0);
  assert.equal(extractComparatives(null).total, 0);
});

test('detects magnitude "more than"', () => {
  const r = extractComparatives('We have more than 5000 users today.');
  assert.ok(r.entries.some((e) => e.kind === 'magnitude'));
});

test('detects "greater than"', () => {
  const r = extractComparatives('Latency is greater than 100ms here.');
  assert.ok(r.entries.some((e) => e.kind === 'magnitude'));
});

test('detects percent comparison', () => {
  const r = extractComparatives('Revenue is 15% higher than last quarter.');
  assert.ok(r.entries.some((e) => e.kind === 'percent'));
});

test('detects multiplier "3x faster"', () => {
  const r = extractComparatives('The new build is 3x faster than the old.');
  assert.ok(r.entries.some((e) => e.kind === 'multiplier'));
});

test('detects "compared to"', () => {
  const r = extractComparatives('Compared to last year, sales doubled.');
  assert.ok(r.entries.some((e) => e.kind === 'vs'));
});

test('detects "versus"', () => {
  const r = extractComparatives('Plan A versus Plan B analysis.');
  assert.ok(r.entries.some((e) => e.kind === 'vs'));
});

test('detects Spanish "más que"', () => {
  const r = extractComparatives('Tenemos más que 5000 usuarios.');
  assert.ok(r.entries.some((e) => e.kind === 'spanish-magnitude'));
});

test('detects Spanish "comparado con"', () => {
  const r = extractComparatives('Comparado con el año pasado, las ventas crecieron.');
  assert.ok(r.entries.some((e) => e.kind === 'vs'));
});

test('counts byKind', () => {
  const r = extractComparatives('More than 100, 15% higher, 3x faster, vs. competitors');
  assert.ok(r.totals.magnitude >= 1);
  assert.ok(r.totals.percent >= 1);
  assert.ok(r.totals.multiplier >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${i}x faster than baseline. `;
  const r = extractComparatives(text);
  assert.ok(r.entries.length <= 20);
});

test('buildComparativesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'more than 100' },
    { name: 'b.md', extractedText: '15% higher' },
  ];
  const r = buildComparativesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderComparativesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'more than 100' }];
  const r = buildComparativesForFiles(files);
  const md = renderComparativesBlock(r);
  assert.match(md, /^## COMPARATIVE CLAIMS/);
});

test('renderComparativesBlock empty when nothing surfaces', () => {
  assert.equal(renderComparativesBlock({ perFile: [] }), '');
  assert.equal(renderComparativesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildComparativesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'more than 100' },
  ]);
  assert.equal(r.perFile.length, 1);
});
