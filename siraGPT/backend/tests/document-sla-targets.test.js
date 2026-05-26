'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-sla-targets');
const { extractSlaTargets, buildSlaTargetsForFiles, renderSlaTargetsBlock, _internal } = engine;
const { classifyUptime, ninesValue } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSlaTargets('').total, 0);
  assert.equal(extractSlaTargets(null).total, 0);
});

test('classifyUptime: nines buckets', () => {
  assert.equal(classifyUptime('99.999'), 'five-nines');
  assert.equal(classifyUptime('99.99'), 'four-nines');
  assert.equal(classifyUptime('99.9'), 'three-nines');
  assert.equal(classifyUptime('99'), 'two-nines');
});

test('ninesValue helper', () => {
  assert.equal(ninesValue('three'), '99.9');
  assert.equal(ninesValue('four'), '99.99');
});

test('detects 99.9% uptime', () => {
  const r = extractSlaTargets('Target 99.9% uptime monthly');
  assert.ok(r.entries.some((e) => e.kind === 'uptime' && /99\.9/.test(e.value)));
});

test('detects "three nines"', () => {
  const r = extractSlaTargets('We need three nines of availability');
  assert.ok(r.entries.some((e) => e.kind === 'uptime' && /three nines/.test(e.value)));
});

test('detects p99 latency target', () => {
  const r = extractSlaTargets('p99 < 200ms required');
  assert.ok(r.entries.some((e) => e.kind === 'latency' && /p99/.test(e.value)));
});

test('detects p95 latency in seconds', () => {
  const r = extractSlaTargets('p95 under 1.5s for API calls');
  assert.ok(r.entries.some((e) => e.kind === 'latency'));
});

test('detects error rate threshold', () => {
  const r = extractSlaTargets('error rate < 0.1% for the quarter');
  assert.ok(r.entries.some((e) => e.kind === 'errorRate'));
});

test('detects throughput rps', () => {
  const r = extractSlaTargets('Handle 5000 rps at peak');
  assert.ok(r.entries.some((e) => e.kind === 'throughput'));
});

test('detects RPO and RTO', () => {
  const r = extractSlaTargets('RPO: 5 minutes, RTO: 30 minutes');
  assert.ok(r.entries.filter((e) => e.kind === 'recovery').length >= 2);
});

test('rejects out-of-range uptime percentages', () => {
  const r = extractSlaTargets('Win rate was 23.5% last year');
  assert.equal(r.entries.filter((e) => e.kind === 'uptime').length, 0);
});

test('dedupes identical targets', () => {
  const r = extractSlaTargets('99.9% uptime here and 99.9% uptime again');
  assert.equal(r.entries.filter((e) => e.kind === 'uptime').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `p${i + 50} < ${100 + i}ms `;
  const r = extractSlaTargets(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractSlaTargets('99.9% uptime, p99 < 200ms, error rate < 0.5%, RPO: 5 min');
  assert.ok(r.totals.uptime >= 1);
  assert.ok(r.totals.latency >= 1);
  assert.ok(r.totals.errorRate >= 1);
  assert.ok(r.totals.recovery >= 1);
});

test('buildSlaTargetsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '99.9% uptime' },
    { name: 'b.md', extractedText: 'p99 < 200ms' },
  ];
  const r = buildSlaTargetsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSlaTargetsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'slo.md', extractedText: '99.9% uptime' }];
  const r = buildSlaTargetsForFiles(files);
  const md = renderSlaTargetsBlock(r);
  assert.match(md, /^## SLA \/ SLO/);
});

test('renderSlaTargetsBlock empty when nothing surfaces', () => {
  assert.equal(renderSlaTargetsBlock({ perFile: [] }), '');
  assert.equal(renderSlaTargetsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSlaTargetsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '99.9% uptime' },
  ]);
  assert.equal(r.perFile.length, 1);
});
