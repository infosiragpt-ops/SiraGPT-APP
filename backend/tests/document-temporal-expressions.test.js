'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-temporal-expressions');
const { extractTemporalExpressions, buildExpressionsForFiles, renderExpressionsBlock } = engine;

test('empty / non-string input tolerated', () => {
  assert.equal(extractTemporalExpressions('').total, 0);
  assert.equal(extractTemporalExpressions(null).total, 0);
});

test('detects past expressions (EN)', () => {
  const r = extractTemporalExpressions('Last quarter the team shipped. Yesterday the platform went live.');
  assert.ok(r.expressions.some((e) => e.kind === 'past'));
});

test('detects past expressions (ES)', () => {
  const r = extractTemporalExpressions('El año pasado vendimos más. Ayer cerramos el contrato.');
  assert.ok(r.expressions.some((e) => e.kind === 'past'));
});

test('detects present expressions', () => {
  const r = extractTemporalExpressions('Today the system is stable. This quarter we focus on growth.');
  assert.ok(r.expressions.some((e) => e.kind === 'present'));
});

test('detects Spanish present expressions', () => {
  const r = extractTemporalExpressions('Hoy revisamos las cifras. Este mes el sistema funcionó bien.');
  assert.ok(r.expressions.some((e) => e.kind === 'present'));
});

test('detects future expressions', () => {
  const r = extractTemporalExpressions('Tomorrow we ship. Next quarter we plan to expand into Europe.');
  assert.ok(r.expressions.some((e) => e.kind === 'future'));
});

test('detects Spanish future expressions', () => {
  const r = extractTemporalExpressions('El próximo trimestre lanzamos el producto. Mañana es la presentación.');
  assert.ok(r.expressions.some((e) => e.kind === 'future'));
});

test('detects boundary expressions', () => {
  const r = extractTemporalExpressions('We aim to deliver by end of quarter. The audit closes by EOY.');
  assert.ok(r.expressions.some((e) => e.kind === 'boundary'));
});

test('detects Spanish boundary expressions', () => {
  const r = extractTemporalExpressions('Antes de fin de mes entregaremos. El cierre del año será en diciembre.');
  assert.ok(r.expressions.some((e) => e.kind === 'boundary'));
});

test('detects horizon expressions', () => {
  const r = extractTemporalExpressions('Within the next 6 months we plan to scale. Over the next 3 weeks we run the pilot.');
  assert.ok(r.expressions.some((e) => e.kind === 'horizon'));
});

test('detects Spanish horizon expressions', () => {
  const r = extractTemporalExpressions('Dentro de 6 meses estaremos en producción. En los próximos 3 días concluiremos la fase piloto.');
  assert.ok(r.expressions.some((e) => e.kind === 'horizon'));
});

test('dedupes identical phrase + sentence pairs', () => {
  const r = extractTemporalExpressions('Today the system is stable. Today the system is stable.');
  assert.equal(r.total, 1);
});

test('buildExpressionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Tomorrow we ship.' },
    { name: 'b.md', extractedText: 'Next quarter we expand.' },
  ];
  const r = buildExpressionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderExpressionsBlock returns markdown when items exist', () => {
  const files = [{ name: 'demo.md', extractedText: 'Next quarter we ship.' }];
  const r = buildExpressionsForFiles(files);
  const md = renderExpressionsBlock(r);
  assert.match(md, /^## TEMPORAL EXPRESSIONS/);
});

test('renderExpressionsBlock empty when nothing surfaces', () => {
  assert.equal(renderExpressionsBlock({ perFile: [] }), '');
  assert.equal(renderExpressionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildExpressionsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Today we ship.' }]);
  assert.equal(r.perFile.length, 1);
});
