'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-numeric-coherence');
const {
  checkNumericCoherence,
  buildCoherenceForFiles,
  renderCoherenceBlock,
  _internal,
} = engine;
const { parseNumeric } = _internal;

test('parseNumeric: US and EU number formats', () => {
  assert.equal(parseNumeric('1,200.50'), 1200.5);
  assert.equal(parseNumeric('1.200,50'), 1200.5);
  assert.equal(parseNumeric('1200'), 1200);
  assert.equal(parseNumeric('$50,000 USD'), 50000);
  assert.equal(parseNumeric('15.5%'), 15.5);
  assert.equal(parseNumeric(''), null);
  assert.equal(parseNumeric(null), null);
});

test('empty input returns a clean report', () => {
  const r = checkNumericCoherence('');
  assert.equal(r.totalFindings, 0);
  assert.equal(r.severity.level, 'none');
});

test('non-string input tolerated', () => {
  assert.equal(checkNumericCoherence(null).totalFindings, 0);
  assert.equal(checkNumericCoherence(undefined).totalFindings, 0);
  assert.equal(checkNumericCoherence(42).totalFindings, 0);
});

test('percentage group sums cleanly → info confirmation', () => {
  const text = `Distribución por canal:
- Web: 40%
- Móvil: 35%
- Email: 15%
- Otros: 10%`;
  const r = checkNumericCoherence(text);
  const f = r.findings.find((x) => x.kind === 'percentage_group_sum' && x.severity === 'info');
  assert.ok(f, `expected info-level percentage_group_sum, got ${JSON.stringify(r.findings.map((x) => [x.kind, x.severity]))}`);
  assert.equal(f.computed.count, 4);
  assert.ok(Math.abs(f.computed.sum - 100) <= 1.5);
});

test('percentage group overflowing 100% → error', () => {
  const text = `Reparto regional:
Region Norte: 45%
Region Sur: 40%
Region Centro: 30%`;
  const r = checkNumericCoherence(text);
  const f = r.findings.find((x) => x.kind === 'percentage_group_sum' && x.severity === 'error');
  assert.ok(f, 'expected overflow error');
  assert.ok(f.computed.sum > 100);
});

test('percentage group under 100% → warning', () => {
  const text = `Composición:
A: 30%
B: 20%
C: 15%`;
  const r = checkNumericCoherence(text);
  const f = r.findings.find((x) => x.kind === 'percentage_group_sum' && x.severity === 'warn');
  assert.ok(f, 'expected under-100% warning');
  assert.ok(f.computed.sum < 100);
});

test('ratio inconsistencies caught', () => {
  const text = '125 of 100 respondents agreed with the proposal.';
  const r = checkNumericCoherence(text);
  assert.ok(r.findings.some((f) => f.kind === 'ratio_inconsistency'));
});

test('growth arithmetic mismatch flagged', () => {
  const text = 'Ingresos crecieron del 100 al 120 (50%) en el trimestre.';
  const r = checkNumericCoherence(text);
  const f = r.findings.find((x) => x.kind === 'growth_mismatch');
  assert.ok(f, `expected growth mismatch, got ${JSON.stringify(r.findings.map((x) => x.kind))}`);
  assert.equal(f.computed.from, 100);
  assert.equal(f.computed.to, 120);
});

test('growth arithmetic that matches is NOT flagged', () => {
  const text = 'Revenue increased from 100 to 120 (20%).';
  const r = checkNumericCoherence(text);
  assert.equal(r.findings.filter((f) => f.kind === 'growth_mismatch').length, 0);
});

test('currency mix near a total flagged', () => {
  const text = `Resumen financiero
Subtotal: USD 12,500
IVA EUR 1,500
Total: $14,000`;
  const r = checkNumericCoherence(text);
  assert.ok(r.findings.some((f) => f.kind === 'currency_mix'));
});

test('average out of declared range flagged', () => {
  const text = `Estadísticas mensuales:
Minimum: 10
Maximum: 30
Average: 80`;
  const r = checkNumericCoherence(text);
  assert.ok(r.findings.some((f) => f.kind === 'average_out_of_range' && f.severity === 'error'));
});

test('share overflow across stakeholders flagged', () => {
  const text = 'Carlos owns 60% of the equity and María holds 50% of the company.';
  const r = checkNumericCoherence(text);
  assert.ok(r.findings.some((f) => f.kind === 'share_overflow'));
});

test('buildCoherenceForFiles aggregates per-file', () => {
  const files = [
    { name: 'finanzas.pdf', extractedText: 'Revenue increased from 100 to 110 (50%).' },
    { name: 'shares.docx', extractedText: 'Owns 70% of the stock. Holds 50% of the company.' },
  ];
  const batch = buildCoherenceForFiles(files);
  assert.equal(batch.perFile.length, 2);
  assert.ok(batch.aggregate.totalFindings >= 2);
  const fileNames = batch.perFile.map((p) => p.file).sort();
  assert.deepEqual(fileNames, ['finanzas.pdf', 'shares.docx']);
});

test('renderCoherenceBlock produces markdown when findings exist', () => {
  const files = [{ name: 'demo.pdf', extractedText: 'Owns 70% of the stock. Holds 50% of the company.' }];
  const batch = buildCoherenceForFiles(files);
  const md = renderCoherenceBlock(batch);
  assert.match(md, /^## NUMERIC COHERENCE/);
  assert.match(md, /demo\.pdf/);
});

test('renderCoherenceBlock returns empty when nothing fires', () => {
  const files = [{ name: 'clean.pdf', extractedText: 'Hello world, how are you?' }];
  const batch = buildCoherenceForFiles(files);
  assert.equal(renderCoherenceBlock(batch), '');
});

test('severity aggregation reflects worst finding', () => {
  const r = checkNumericCoherence(`Distribution:
A: 45%
B: 40%
C: 30%`);
  assert.equal(r.severity.level, 'high');
});
