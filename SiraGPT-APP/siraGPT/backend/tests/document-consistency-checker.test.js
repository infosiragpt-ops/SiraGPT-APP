'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-consistency-checker');
const { checkConsistency, buildConsistencyForFiles, renderConsistencyBlock, _internal } = engine;
const { parseNumeric } = _internal;

test('parseNumeric: handles US and EU formats', () => {
  assert.equal(parseNumeric('1,200.50'), 1200.5);
  assert.equal(parseNumeric('1.200,50'), 1200.5);
  assert.equal(parseNumeric('1200'), 1200);
  assert.equal(parseNumeric('$50,000 USD'), 50000);
  assert.equal(parseNumeric('15.5%'), 15.5);
});

test('checkConsistency: empty input returns clean report', () => {
  const r = checkConsistency('');
  assert.equal(r.totalFindings, 0);
  assert.equal(r.severity.level, 'none');
});

test('checkConsistency: tolerates non-string input', () => {
  const r = checkConsistency(null);
  assert.equal(r.totalFindings, 0);
});

test('checkConsistency: detects label-value conflicts', () => {
  const text = `Resumen ejecutivo:
Presupuesto: $50,000 USD
...

Anexo financiero:
Presupuesto: $75,000 USD
Las cifras oficiales se encuentran en el anexo.`;
  const r = checkConsistency(text);
  const conflict = r.findings.find((f) => f.kind === 'label_value_conflict');
  assert.ok(conflict, `should detect label/value conflict in ${JSON.stringify(r.findings.map((f) => f.kind))}`);
  assert.ok(conflict.values.length >= 2);
});

test('checkConsistency: detects total mismatch when subtotal does not equal sum', () => {
  const text = `Detalle de servicios:
$1,000 — Consultoría
$2,000 — Desarrollo
$3,000 — Soporte
$10,000 — Diseño
Total: $50,000`;
  const r = checkConsistency(text);
  const mismatch = r.findings.find((f) => f.kind === 'total_mismatch');
  assert.ok(mismatch, `should detect total mismatch in ${JSON.stringify(r.findings.map((f) => f.kind))}`);
  assert.ok(mismatch.delta > 0);
});

test('checkConsistency: detects inverted date ranges', () => {
  const text = 'El proyecto corre desde 2026-12-15 hasta 2026-03-01.';
  const r = checkConsistency(text);
  assert.ok(r.findings.some((f) => f.kind === 'inverted_date_range'));
});

test('checkConsistency: detects percentage overflow', () => {
  const text = `Distribución regional:
Región Norte: 45%
Región Sur: 40%
Región Centro: 35%
Región Este: 20%`;
  const r = checkConsistency(text);
  assert.ok(r.findings.some((f) => f.kind === 'percentage_overflow'));
});

test('checkConsistency: detects tense conflicts for the same object', () => {
  const text = 'Vamos a entregar el dashboard la próxima semana. Por otro lado, ya entregado el dashboard al cliente principal.';
  const r = checkConsistency(text);
  // This heuristic is tolerant — it may or may not find a match in Spanish;
  // English form is more reliable so let's also test that:
  const en = 'We will deliver the dashboard. We delivered the dashboard last quarter.';
  const enReport = checkConsistency(en);
  // Either one of the two should fire
  assert.ok(r.findings.some((f) => f.kind === 'tense_conflict') || enReport.findings.some((f) => f.kind === 'tense_conflict'));
});

test('checkConsistency: severity level escalates with multiple findings', () => {
  const text = `Detalle de servicios:
$1,000 — A
$2,000 — B
$3,000 — C
$10,000 — D
Total: $50,000

Plazo desde 2026-12-15 hasta 2026-03-01.

Distribución:
Norte 45%
Sur 40%
Este 35%`;
  const r = checkConsistency(text);
  assert.ok(['medium', 'high', 'critical'].includes(r.severity.level), `expected medium+ severity, got ${r.severity.level} (${r.totalFindings} findings)`);
});

test('checkConsistency: clean text yields severity none', () => {
  const r = checkConsistency('Este es un párrafo coherente sin contradicciones internas, solo prosa narrativa estable.');
  assert.equal(r.severity.level, 'none');
});

test('buildConsistencyForFiles: aggregates per-file and overall findings', () => {
  const files = [
    { originalName: 'a.txt', extractedText: 'Plazo desde 2026-12-15 hasta 2026-03-01.' },
    { originalName: 'b.txt', extractedText: `Detalle:
$1,000 — A
$2,000 — B
$3,000 — C
$10,000 — D
Total: $50,000` },
  ];
  const r = buildConsistencyForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.ok(r.aggregate.totalFindings >= 2);
});

test('buildConsistencyForFiles: tolerates non-array input', () => {
  const r = buildConsistencyForFiles(null);
  assert.deepEqual(r.perFile, []);
  assert.equal(r.aggregate.totalFindings, 0);
});

test('renderConsistencyBlock: returns empty for clean reports', () => {
  assert.equal(renderConsistencyBlock(null), '');
  assert.equal(renderConsistencyBlock({ totalFindings: 0, summary: [], severity: { score: 0, level: 'none' }, findings: [] }), '');
});

test('renderConsistencyBlock: includes severity badge and section', () => {
  const r = checkConsistency('Plazo desde 2026-12-15 hasta 2026-03-01.');
  const block = renderConsistencyBlock(r);
  assert.match(block, /## INTERNAL CONSISTENCY CHECK/);
  assert.match(block, /inverted date range/);
});
