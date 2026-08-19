'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sla-terms');
const { extractSLATerms, buildSLATermsForFiles, renderSLATermsBlock, _internal } = engine;
const { detectKind } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSLATerms('').total, 0);
  assert.equal(extractSLATerms(null).total, 0);
});

test('detectKind: uptime', () => {
  assert.equal(detectKind('The service guarantees 99.95% uptime monthly.'), 'uptime');
  assert.equal(detectKind('Monthly availability of 99.99% is committed.'), 'uptime');
  assert.equal(detectKind('Garantizamos disponibilidad mensual del 99.9%.'), 'uptime');
});

test('detectKind: response time', () => {
  assert.equal(detectKind('P1 response time of 1 hour applies.'), 'response-time');
  assert.equal(detectKind('Tiempo de respuesta de 30 minutos para incidentes P1.'), 'response-time');
});

test('detectKind: resolution time', () => {
  assert.equal(detectKind('Resolution within 4 business hours for P1 incidents.'), 'resolution');
  assert.equal(detectKind('Tiempo de resolución de 8 horas para casos urgentes.'), 'resolution');
});

test('detectKind: credit policy', () => {
  assert.equal(detectKind('Service credit of 10% applies for SLA breaches.'), 'credit-policy');
  assert.equal(detectKind('Crédito de servicio del 5% por cada incumplimiento.'), 'credit-policy');
});

test('detectKind: RPO / RTO', () => {
  assert.equal(detectKind('The platform guarantees an RPO of 1 hour.'), 'rpo');
  assert.equal(detectKind('An RTO of 4 hours is committed for disaster recovery.'), 'rto');
});

test('detectKind: non-SLA returns null', () => {
  assert.equal(detectKind('The team had lunch on Tuesday.'), null);
});

test('extracts multiple SLA terms in one document', () => {
  const text = `The service guarantees 99.95% uptime monthly. Response time of 1 hour for P1. Service credit of 10% for breaches.`;
  const r = extractSLATerms(text);
  assert.ok(r.total >= 3);
});

test('dedupes identical sentences', () => {
  const text = '99.99% uptime monthly. 99.99% uptime monthly.';
  const r = extractSLATerms(text);
  assert.equal(r.total, 1);
});

test('buildSLATermsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '99.95% uptime monthly applies.' },
    { name: 'b.md', extractedText: 'Service credit of 10% per breach.' },
  ];
  const r = buildSLATermsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSLATermsBlock returns markdown when items exist', () => {
  const files = [{ name: 'sla.md', extractedText: '99.95% uptime monthly is committed.' }];
  const r = buildSLATermsForFiles(files);
  const md = renderSLATermsBlock(r);
  assert.match(md, /^## SLA TERMS/);
});

test('renderSLATermsBlock empty when nothing surfaces', () => {
  assert.equal(renderSLATermsBlock({ perFile: [] }), '');
  assert.equal(renderSLATermsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSLATermsForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '99.9% uptime applies.' }]);
  assert.ok(Array.isArray(r.perFile));
});
