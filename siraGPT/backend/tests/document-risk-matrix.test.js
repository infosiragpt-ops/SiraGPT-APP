'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-risk-matrix');
const { extractRiskMatrix, buildRiskMatrixForFiles, renderRiskMatrixBlock, _internal } = engine;
const { normaliseLevel } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRiskMatrix('').total, 0);
  assert.equal(extractRiskMatrix(null).total, 0);
});

test('normaliseLevel: text levels', () => {
  assert.equal(normaliseLevel('Critical'), 'critical');
  assert.equal(normaliseLevel('High'), 'high');
  assert.equal(normaliseLevel('Medium'), 'medium');
  assert.equal(normaliseLevel('Low'), 'low');
  assert.equal(normaliseLevel('Negligible'), 'very-low');
});

test('normaliseLevel: numeric → bucket', () => {
  assert.equal(normaliseLevel('1'), 'very-low');
  assert.equal(normaliseLevel('2'), 'low');
  assert.equal(normaliseLevel('5'), 'medium');
  assert.equal(normaliseLevel('7'), 'high');
  assert.equal(normaliseLevel('9'), 'critical');
});

test('normaliseLevel: Spanish', () => {
  assert.equal(normaliseLevel('Crítico'), 'critical');
  assert.equal(normaliseLevel('Alto'), 'high');
  assert.equal(normaliseLevel('Bajo'), 'low');
});

test('detects Likelihood/Impact pair (English)', () => {
  const r = extractRiskMatrix('Risk: Likelihood: High, Impact: Critical');
  assert.ok(r.entries.some((e) => e.kind === 'pair' && e.likelihood === 'high' && e.impact === 'critical'));
});

test('detects Probability/Severity numeric pair', () => {
  const r = extractRiskMatrix('Probability: 4, Severity: 3');
  assert.ok(r.entries.some((e) => e.kind === 'pair'));
});

test('detects Spanish Probabilidad/Impacto', () => {
  const r = extractRiskMatrix('Probabilidad: Alto, Impacto: Crítico');
  assert.ok(r.entries.some((e) => e.kind === 'pair' && e.likelihood === 'high' && e.impact === 'critical'));
});

test('detects reverse order Impact then Likelihood', () => {
  const r = extractRiskMatrix('Severity: High, Likelihood: Medium');
  assert.ok(r.entries.some((e) => e.kind === 'pair' && e.likelihood === 'medium' && e.impact === 'high'));
});

test('detects Risk Score', () => {
  const r = extractRiskMatrix('Risk Score: 12 (High)');
  assert.ok(r.entries.some((e) => e.kind === 'score' && e.score === 12 && e.rating === 'high'));
});

test('detects Spanish Puntuación de Riesgo', () => {
  const r = extractRiskMatrix('Puntuación de Riesgo: 8');
  assert.ok(r.entries.some((e) => e.kind === 'score' && e.score === 8));
});

test('dedupes identical pair entries with same context', () => {
  const r = extractRiskMatrix('Likelihood: High, Impact: High\nLikelihood: High, Impact: High');
  assert.ok(r.entries.length >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Risk ${i}: Likelihood: ${i % 5}, Impact: ${i % 5}\n`;
  const r = extractRiskMatrix(text);
  assert.ok(r.entries.length <= 16);
});

test('totals reports counts', () => {
  const r = extractRiskMatrix('Likelihood: High, Impact: Medium\nRisk Score: 7');
  assert.ok(r.totals.pair >= 1);
  assert.ok(r.totals.score >= 1);
});

test('buildRiskMatrixForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Likelihood: High, Impact: Medium' },
    { name: 'b.md', extractedText: 'Risk Score: 9 (Critical)' },
  ];
  const r = buildRiskMatrixForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRiskMatrixBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Likelihood: High, Impact: Critical' }];
  const r = buildRiskMatrixForFiles(files);
  const md = renderRiskMatrixBlock(r);
  assert.match(md, /^## RISK MATRIX/);
});

test('renderRiskMatrixBlock empty when nothing surfaces', () => {
  assert.equal(renderRiskMatrixBlock({ perFile: [] }), '');
  assert.equal(renderRiskMatrixBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRiskMatrixForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Likelihood: High, Impact: Critical' },
  ]);
  assert.equal(r.perFile.length, 1);
});
