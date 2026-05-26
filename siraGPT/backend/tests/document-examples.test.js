'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-examples');
const { extractExamples, buildExamplesForFiles, renderExamplesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractExamples('').total, 0);
  assert.equal(extractExamples(null).total, 0);
});

test('detects "for example"', () => {
  const r = extractExamples('Use a strong cipher, for example AES-256.');
  assert.ok(r.entries.some((e) => e.kind === 'eg'));
});

test('detects "e.g."', () => {
  const r = extractExamples('Use HTTPS (e.g., TLS 1.3).');
  assert.ok(r.entries.some((e) => e.kind === 'eg'));
});

test('detects "such as"', () => {
  const r = extractExamples('Modern web frameworks such as React.');
  assert.ok(r.entries.some((e) => e.kind === 'such-as'));
});

test('detects "i.e."', () => {
  const r = extractExamples('Network bytes (i.e., physical layer 1).');
  assert.ok(r.entries.some((e) => e.kind === 'ie'));
});

test('detects "namely"', () => {
  const r = extractExamples('Two methods, namely A and B.');
  assert.ok(r.entries.some((e) => e.kind === 'ie'));
});

test('detects Spanish "por ejemplo"', () => {
  const r = extractExamples('Lenguajes modernos, por ejemplo Python y Go.');
  assert.ok(r.entries.some((e) => e.kind === 'por-ejemplo'));
});

test('detects Spanish "es decir"', () => {
  const r = extractExamples('Es decir, debemos validar antes.');
  assert.ok(r.entries.some((e) => e.kind === 'es-decir'));
});

test('counts byKind', () => {
  const r = extractExamples('For example yes. Such as no. I.e. maybe. Por ejemplo sí.');
  assert.ok(r.totals.eg >= 1);
  assert.ok(r.totals['such-as'] >= 1);
  assert.ok(r.totals.ie >= 1);
  assert.ok(r.totals['por-ejemplo'] >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `For example item ${i}. `;
  const r = extractExamples(text);
  assert.ok(r.entries.length <= 20);
});

test('buildExamplesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'For example yes.' },
    { name: 'b.md', extractedText: 'Por ejemplo sí.' },
  ];
  const r = buildExamplesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderExamplesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'For example yes.' }];
  const r = buildExamplesForFiles(files);
  const md = renderExamplesBlock(r);
  assert.match(md, /^## EXAMPLE MARKERS/);
});

test('renderExamplesBlock empty when nothing surfaces', () => {
  assert.equal(renderExamplesBlock({ perFile: [] }), '');
  assert.equal(renderExamplesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildExamplesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'For example yes.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
