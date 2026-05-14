'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-saas-metrics');
const { extractSaasMetrics, buildSaasMetricsForFiles, renderSaasMetricsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSaasMetrics('').total, 0);
  assert.equal(extractSaasMetrics(null).total, 0);
});

test('detects ARR', () => {
  const r = extractSaasMetrics('Our ARR hit $10M this quarter.');
  assert.ok(r.entries.some((e) => e.metric === 'ARR'));
});

test('detects MRR with value', () => {
  const r = extractSaasMetrics('MRR = $500K');
  assert.ok(r.entries.some((e) => e.metric === 'MRR' && e.source === 'with-value'));
});

test('detects CAC and LTV', () => {
  const r = extractSaasMetrics('CAC: $120, LTV: $3500');
  assert.ok(r.entries.some((e) => e.metric === 'CAC'));
  assert.ok(r.entries.some((e) => e.metric === 'LTV'));
});

test('detects LTV:CAC ratio', () => {
  const r = extractSaasMetrics('Target LTV:CAC 4x ratio');
  assert.ok(r.entries.some((e) => e.metric === 'LTV:CAC'));
});

test('detects churn rate', () => {
  const r = extractSaasMetrics('Monthly churn rate around 2%');
  assert.ok(r.entries.some((e) => /churn/i.test(e.metric)));
});

test('detects NRR retention', () => {
  const r = extractSaasMetrics('NRR holding at 115%');
  assert.ok(r.entries.some((e) => e.metric === 'NRR'));
});

test('detects DAU/MAU engagement', () => {
  const r = extractSaasMetrics('DAU/MAU = 0.42');
  assert.ok(r.entries.some((e) => e.category === 'engagement'));
});

test('detects NPS', () => {
  const r = extractSaasMetrics('NPS score: 67');
  assert.ok(r.entries.some((e) => e.metric === 'NPS' && e.category === 'sentiment'));
});

test('detects D7 retention', () => {
  const r = extractSaasMetrics('D7 retention is 35%');
  assert.ok(r.entries.some((e) => e.source === 'n-day'));
});

test('detects activation funnel', () => {
  const r = extractSaasMetrics('Improve activation rate by 10%');
  assert.ok(r.entries.some((e) => e.category === 'funnel'));
});

test('dedupes identical entries', () => {
  const r = extractSaasMetrics('ARR here and ARR again');
  assert.equal(r.entries.filter((e) => e.metric === 'ARR' && e.source === 'mention').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const terms = ['ARR', 'MRR', 'CAC', 'LTV', 'NPS', 'CSAT', 'DAU', 'MAU', 'churn', 'NRR'];
  for (let i = 0; i < 20; i++) text += `${terms[i % terms.length]} `;
  const r = extractSaasMetrics(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by category', () => {
  const r = extractSaasMetrics('ARR $10M, CAC $120, churn 2%, NPS 67');
  assert.ok(r.totals.revenue >= 1);
  assert.ok(r.totals['unit-econ'] >= 1);
  assert.ok(r.totals.retention >= 1);
  assert.ok(r.totals.sentiment >= 1);
});

test('buildSaasMetricsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'ARR $10M' },
    { name: 'b', extractedText: 'NPS 67' },
  ];
  const r = buildSaasMetricsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSaasMetricsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'deck', extractedText: 'ARR hit $10M' }];
  const r = buildSaasMetricsForFiles(files);
  const md = renderSaasMetricsBlock(r);
  assert.match(md, /^## SAAS/);
});

test('renderSaasMetricsBlock empty when nothing surfaces', () => {
  assert.equal(renderSaasMetricsBlock({ perFile: [] }), '');
  assert.equal(renderSaasMetricsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSaasMetricsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'ARR $10M' },
  ]);
  assert.equal(r.perFile.length, 1);
});
