'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-causal');
const { extractCausal, buildCausalForFiles, renderCausalBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCausal('').total, 0);
  assert.equal(extractCausal(null).total, 0);
});

test('detects "because"', () => {
  const r = extractCausal('Tests failed because the deployment was incomplete.');
  assert.ok(r.entries.some((e) => e.kind === 'because'));
});

test('detects "due to"', () => {
  const r = extractCausal('Service was down due to a database outage.');
  assert.ok(r.entries.some((e) => e.kind === 'dueto'));
});

test('detects "owing to"', () => {
  const r = extractCausal('Owing to the storm, traffic was rerouted.');
  assert.ok(r.entries.some((e) => e.kind === 'owingto'));
});

test('detects "as a result of"', () => {
  const r = extractCausal('Latency spiked as a result of the new query.');
  assert.ok(r.entries.some((e) => e.kind === 'asaresult'));
});

test('detects "thanks to"', () => {
  const r = extractCausal('Thanks to caching, response times improved.');
  assert.ok(r.entries.some((e) => e.kind === 'thanksto'));
});

test('detects Spanish "debido a"', () => {
  const r = extractCausal('El servicio falló debido a un error de configuración.');
  assert.ok(r.entries.some((e) => e.kind === 'debidoa'));
});

test('detects Spanish "porque"', () => {
  const r = extractCausal('La caída ocurrió porque el disco se llenó.');
  assert.ok(r.entries.some((e) => e.kind === 'porque'));
});

test('detects "ya que"', () => {
  const r = extractCausal('No podemos avanzar ya que falta la aprobación.');
  assert.ok(r.entries.some((e) => e.kind === 'yaque'));
});

test('counts byKind', () => {
  const r = extractCausal('Failed because slow. Outage due to issue. Debido a falla.');
  assert.ok(r.totals.because >= 1);
  assert.ok(r.totals.dueto >= 1);
  assert.ok(r.totals.debidoa >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Item ${i} because of x${i}. `;
  const r = extractCausal(text);
  assert.ok(r.entries.length <= 20);
});

test('buildCausalForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Failed because of slowness.' },
    { name: 'b.md', extractedText: 'Outage due to error.' },
  ];
  const r = buildCausalForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCausalBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Failed because of x.' }];
  const r = buildCausalForFiles(files);
  const md = renderCausalBlock(r);
  assert.match(md, /^## CAUSAL MARKERS/);
});

test('renderCausalBlock empty when nothing surfaces', () => {
  assert.equal(renderCausalBlock({ perFile: [] }), '');
  assert.equal(renderCausalBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCausalForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Failed because of x.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
