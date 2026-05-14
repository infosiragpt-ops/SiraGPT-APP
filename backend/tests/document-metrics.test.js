'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-metrics');
const { extractMetrics, buildMetricsForFiles, renderMetricsBlock, _internal } = engine;
const { classifyMetric } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractMetrics('').total, 0);
  assert.equal(extractMetrics(null).total, 0);
});

test('classifyMetric: counter / histogram / gauge', () => {
  assert.equal(classifyMetric('http_requests_total'), 'counter');
  assert.equal(classifyMetric('request_duration_seconds'), 'histogram');
  assert.equal(classifyMetric('memory_bytes'), 'gauge');
});

test('detects http_requests_total', () => {
  const r = extractMetrics('Counter http_requests_total fired');
  assert.ok(r.entries.some((e) => e.name === 'http_requests_total' && e.type === 'counter'));
});

test('detects request_duration_seconds', () => {
  const r = extractMetrics('Histogram request_duration_seconds_bucket');
  assert.ok(r.entries.some((e) => /duration_seconds/.test(e.name)));
});

test('detects memory_usage_bytes', () => {
  const r = extractMetrics('Gauge memory_usage_bytes today');
  assert.ok(r.entries.some((e) => e.name === 'memory_usage_bytes'));
});

test('detects labeled "counter: name"', () => {
  const r = extractMetrics('counter: api_calls_total');
  assert.ok(r.entries.some((e) => e.source === 'labeled'));
});

test('dedupes identical metrics', () => {
  const r = extractMetrics('http_requests_total here and http_requests_total again');
  assert.equal(r.entries.filter((e) => e.name === 'http_requests_total').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `metric_${i}_total `;
  const r = extractMetrics(text);
  assert.ok(r.entries.length <= 24);
});

test('counts byType', () => {
  const r = extractMetrics('http_requests_total memory_bytes request_duration_seconds');
  assert.ok(r.totals.counter >= 1);
  assert.ok(r.totals.gauge >= 1);
  assert.ok(r.totals.histogram >= 1);
});

test('buildMetricsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'http_requests_total' },
    { name: 'b.md', extractedText: 'memory_usage_bytes' },
  ];
  const r = buildMetricsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMetricsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'http_requests_total' }];
  const r = buildMetricsForFiles(files);
  const md = renderMetricsBlock(r);
  assert.match(md, /^## OBSERVABILITY METRICS/);
});

test('renderMetricsBlock empty when nothing surfaces', () => {
  assert.equal(renderMetricsBlock({ perFile: [] }), '');
  assert.equal(renderMetricsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMetricsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'http_requests_total' },
  ]);
  assert.equal(r.perFile.length, 1);
});
