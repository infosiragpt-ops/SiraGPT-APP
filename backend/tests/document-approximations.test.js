'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-approximations');
const { extractApproximations, buildApproximationsForFiles, renderApproximationsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractApproximations('').total, 0);
  assert.equal(extractApproximations(null).total, 0);
});

test('detects "approximately"', () => {
  const r = extractApproximations('Approximately 500 users today.');
  assert.ok(r.entries.length >= 1);
});

test('detects "roughly"', () => {
  const r = extractApproximations('Roughly half the team agreed.');
  assert.ok(r.entries.length >= 1);
});

test('detects "about N"', () => {
  const r = extractApproximations('About 1000 requests per second.');
  assert.ok(r.entries.length >= 1);
});

test('detects "around N"', () => {
  const r = extractApproximations('Around 50 errors per hour.');
  assert.ok(r.entries.length >= 1);
});

test('detects "nearly"', () => {
  const r = extractApproximations('Nearly complete by end of week.');
  assert.ok(r.entries.length >= 1);
});

test('detects Spanish "aproximadamente"', () => {
  const r = extractApproximations('Aproximadamente 500 usuarios diarios.');
  assert.ok(r.entries.length >= 1);
});

test('detects "alrededor de"', () => {
  const r = extractApproximations('Alrededor de mil solicitudes por segundo.');
  assert.ok(r.entries.length >= 1);
});

test('detects "cerca de"', () => {
  const r = extractApproximations('Cerca de 50 errores por hora.');
  assert.ok(r.entries.length >= 1);
});

test('detects ~N symbolic form', () => {
  const r = extractApproximations('Latency ~50ms typical.');
  assert.ok(r.entries.length >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Approximately ${i} items. `;
  const r = extractApproximations(text);
  assert.ok(r.entries.length <= 20);
});

test('buildApproximationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Approximately 500.' },
    { name: 'b.md', extractedText: 'Roughly 100.' },
  ];
  const r = buildApproximationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderApproximationsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Approximately 100.' }];
  const r = buildApproximationsForFiles(files);
  const md = renderApproximationsBlock(r);
  assert.match(md, /^## APPROXIMATION HEDGES/);
});

test('renderApproximationsBlock empty when nothing surfaces', () => {
  assert.equal(renderApproximationsBlock({ perFile: [] }), '');
  assert.equal(renderApproximationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildApproximationsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Approximately 100.' },
  ]);
  assert.equal(r.perFile.length, 1);
});
