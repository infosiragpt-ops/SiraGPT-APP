'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ordinals');
const { extractOrdinals, buildOrdinalsForFiles, renderOrdinalsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractOrdinals('').total, 0);
  assert.equal(extractOrdinals(null).total, 0);
});

test('detects 1st suffix', () => {
  const r = extractOrdinals('Ranked 1st in the leaderboard.');
  assert.ok(r.entries.some((e) => e.kind === 'suffix-en'));
});

test('detects 22nd', () => {
  const r = extractOrdinals('22nd attempt finally worked.');
  assert.ok(r.entries.some((e) => e.kind === 'suffix-en'));
});

test('detects English word "first"', () => {
  const r = extractOrdinals('The first attempt failed.');
  assert.ok(r.entries.some((e) => e.kind === 'word-en' && e.phrase === 'first'));
});

test('detects "third" / "tenth"', () => {
  const r = extractOrdinals('The third try succeeded after the tenth attempt.');
  assert.ok(r.entries.some((e) => e.phrase === 'third'));
  assert.ok(r.entries.some((e) => e.phrase === 'tenth'));
});

test('detects Spanish "primero"', () => {
  const r = extractOrdinals('El primero en llegar.');
  assert.ok(r.entries.some((e) => e.phrase === 'primero'));
});

test('detects Spanish "segunda"', () => {
  const r = extractOrdinals('La segunda opción.');
  assert.ok(r.entries.some((e) => e.phrase === 'segunda'));
});

test('detects Spanish suffix 1º', () => {
  const r = extractOrdinals('Llegó en el 1º lugar.');
  assert.ok(r.entries.some((e) => e.kind === 'suffix-es'));
});

test('detects "tercer" via tercero word', () => {
  const r = extractOrdinals('El tercero en la fila.');
  assert.ok(r.entries.some((e) => e.phrase === 'tercero'));
});

test('counts byKind', () => {
  const r = extractOrdinals('1st place. Second attempt. 1º intento.');
  assert.ok(r.totals['suffix-en'] >= 1);
  assert.ok(r.totals['word-en'] >= 1);
  assert.ok(r.totals['suffix-es'] >= 1);
});

test('dedupes identical entries', () => {
  const r = extractOrdinals('1st place vs 1st place comparison.');
  assert.equal(r.entries.filter((e) => e.phrase === '1st').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `${i + 1}st item. `;
  const r = extractOrdinals(text);
  assert.ok(r.entries.length <= 24);
});

test('buildOrdinalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '1st place' },
    { name: 'b.md', extractedText: '2nd place' },
  ];
  const r = buildOrdinalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOrdinalsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '1st place' }];
  const r = buildOrdinalsForFiles(files);
  const md = renderOrdinalsBlock(r);
  assert.match(md, /^## ORDINALS/);
});

test('renderOrdinalsBlock empty when nothing surfaces', () => {
  assert.equal(renderOrdinalsBlock({ perFile: [] }), '');
  assert.equal(renderOrdinalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOrdinalsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '1st place' },
  ]);
  assert.equal(r.perFile.length, 1);
});
