'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ratios');
const { extractRatios, buildRatiosForFiles, renderRatiosBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractRatios('').total, 0);
  assert.equal(extractRatios(null).total, 0);
});

test('detects colon ratio 3:1', () => {
  const r = extractRatios('The cache ratio is 3:1 typically.');
  assert.ok(r.entries.some((e) => e.kind === 'colon' && e.phrase === '3:1'));
});

test('detects 3-way colon 5:2:1', () => {
  const r = extractRatios('Distribution 5:2:1 across regions.');
  assert.ok(r.entries.some((e) => e.kind === 'colon'));
});

test('detects "3 to 1"', () => {
  const r = extractRatios('Win-loss is 3 to 1 today.');
  assert.ok(r.entries.some((e) => e.kind === 'word-en'));
});

test('detects "3-to-1"', () => {
  const r = extractRatios('Ratio of 3-to-1 observed.');
  assert.ok(r.entries.some((e) => e.kind === 'hyphen-en'));
});

test('detects "X per Y"', () => {
  const r = extractRatios('100 requests per second sustained.');
  assert.ok(r.entries.some((e) => e.kind === 'per-en'));
});

test('detects Spanish "X por Y"', () => {
  const r = extractRatios('100 solicitudes por segundo sostenidas.');
  assert.ok(r.entries.some((e) => e.kind === 'per-es'));
});

test('detects 2/3 fraction', () => {
  const r = extractRatios('About 2/30 of users opted in.');
  // 2/30 is not date-like (30 days valid but 2 month valid) → date rejection might fire
  // Let me test with a clearer fraction
  const r2 = extractRatios('Coverage is 50/75 cases.');
  assert.ok(r2.entries.some((e) => e.kind === 'fraction'));
});

test('rejects date-like fractions like 1/12', () => {
  const r = extractRatios('Released on 5/15 and 3/22.');
  // 5/15 and 3/22 fit calendar range, should be rejected
  assert.equal(r.entries.filter((e) => e.kind === 'fraction').length, 0);
});

test('dedupes identical entries', () => {
  const r = extractRatios('Ratio 3:1 here and 3:1 there.');
  assert.equal(r.entries.filter((e) => e.phrase === '3:1').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Ratio ${i}:${i + 1} here. `;
  const r = extractRatios(text);
  assert.ok(r.entries.length <= 18);
});

test('buildRatiosForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '3:1 ratio' },
    { name: 'b.md', extractedText: '100 per second' },
  ];
  const r = buildRatiosForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRatiosBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '3:1 ratio' }];
  const r = buildRatiosForFiles(files);
  const md = renderRatiosBlock(r);
  assert.match(md, /^## RATIOS/);
});

test('renderRatiosBlock empty when nothing surfaces', () => {
  assert.equal(renderRatiosBlock({ perFile: [] }), '');
  assert.equal(renderRatiosBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRatiosForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '3:1' },
  ]);
  assert.equal(r.perFile.length, 1);
});
