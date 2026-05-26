'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-concession');
const { extractConcession, buildConcessionForFiles, renderConcessionBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractConcession('').total, 0);
  assert.equal(extractConcession(null).total, 0);
});

test('detects "although"', () => {
  const r = extractConcession('Although tests passed, deployment failed.');
  assert.ok(r.entries.some((e) => e.kind === 'although'));
});

test('detects "however"', () => {
  const r = extractConcession('Tests passed. However, deployment failed.');
  assert.ok(r.entries.some((e) => e.kind === 'however'));
});

test('detects "nevertheless"', () => {
  const r = extractConcession('It was risky. Nevertheless, we shipped.');
  assert.ok(r.entries.some((e) => e.kind === 'nevertheless'));
});

test('detects "in contrast"', () => {
  const r = extractConcession('In contrast, the new design is simpler.');
  assert.ok(r.entries.some((e) => e.kind === 'incontrast'));
});

test('detects "despite"', () => {
  const r = extractConcession('Despite the risks, we proceeded.');
  assert.ok(r.entries.some((e) => e.kind === 'despite'));
});

test('detects Spanish "aunque"', () => {
  const r = extractConcession('Aunque las pruebas pasaron, el despliegue falló.');
  assert.ok(r.entries.some((e) => e.kind === 'aunque'));
});

test('detects Spanish "sin embargo"', () => {
  const r = extractConcession('Las pruebas pasaron. Sin embargo, el despliegue falló.');
  assert.ok(r.entries.some((e) => e.kind === 'sinembargo'));
});

test('detects "no obstante"', () => {
  const r = extractConcession('Era arriesgado. No obstante, lo intentamos.');
  assert.ok(r.entries.some((e) => e.kind === 'noobstante'));
});

test('detects "a pesar de"', () => {
  const r = extractConcession('A pesar de los riesgos, lanzamos.');
  assert.ok(r.entries.some((e) => e.kind === 'peseaa'));
});

test('counts byKind', () => {
  const r = extractConcession('Although yes. However no. Sin embargo, falló.');
  assert.ok(r.totals.although >= 1);
  assert.ok(r.totals.however >= 1);
  assert.ok(r.totals.sinembargo >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Although ${i}. `;
  const r = extractConcession(text);
  assert.ok(r.entries.length <= 20);
});

test('buildConcessionForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Although tests passed.' },
    { name: 'b.md', extractedText: 'Sin embargo, falló.' },
  ];
  const r = buildConcessionForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderConcessionBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'However, it failed.' }];
  const r = buildConcessionForFiles(files);
  const md = renderConcessionBlock(r);
  assert.match(md, /^## CONCESSION/);
});

test('renderConcessionBlock empty when nothing surfaces', () => {
  assert.equal(renderConcessionBlock({ perFile: [] }), '');
  assert.equal(renderConcessionBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildConcessionForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'However, it failed.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
