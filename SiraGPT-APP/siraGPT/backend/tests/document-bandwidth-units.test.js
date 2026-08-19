'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-bandwidth-units');
const { extractBandwidthUnits, buildBandwidthUnitsForFiles, renderBandwidthUnitsBlock, _internal } = engine;
const { normaliseScale, classifyMagnitude } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractBandwidthUnits('').total, 0);
  assert.equal(extractBandwidthUnits(null).total, 0);
});

test('normaliseScale helper', () => {
  assert.equal(normaliseScale('k'), 1000);
  assert.equal(normaliseScale('M'), 1e6);
});

test('classifyMagnitude buckets', () => {
  assert.equal(classifyMagnitude(5e9), 'billion');
  assert.equal(classifyMagnitude(2e6), 'million');
});

test('detects 10 Gbps bandwidth', () => {
  const r = extractBandwidthUnits('10 Gbps uplink');
  assert.ok(r.entries.some((e) => e.kind === 'bandwidth' && /Gbps/.test(e.value)));
});

test('detects 100 Mbps', () => {
  const r = extractBandwidthUnits('100 Mbps connection');
  assert.ok(r.entries.some((e) => e.kind === 'bandwidth'));
});

test('detects 5 PB storage', () => {
  const r = extractBandwidthUnits('Total of 5 PB stored');
  assert.ok(r.entries.some((e) => e.kind === 'storage'));
});

test('detects 10 TB volume', () => {
  const r = extractBandwidthUnits('Backups grew to 10 TB');
  assert.ok(r.entries.some((e) => e.kind === 'storage'));
});

test('rejects RAM/SSD storage already handled elsewhere', () => {
  const r = extractBandwidthUnits('16GB RAM and 256GB SSD');
  // Should not match because it's hardware-specs context
  assert.equal(r.entries.filter((e) => e.kind === 'storage').length, 0);
});

test('detects 5K rps rate', () => {
  const r = extractBandwidthUnits('Handle 5K rps peak');
  assert.ok(r.entries.some((e) => e.kind === 'rate'));
});

test('detects 1M qps', () => {
  const r = extractBandwidthUnits('Database serves 1M qps');
  assert.ok(r.entries.some((e) => e.kind === 'rate'));
});

test('detects "events per second"', () => {
  const r = extractBandwidthUnits('10K events per second');
  assert.ok(r.entries.some((e) => e.kind === 'volume'));
});

test('detects "writes per day"', () => {
  const r = extractBandwidthUnits('1M writes per day');
  assert.ok(r.entries.some((e) => e.kind === 'volume'));
});

test('dedupes identical entries', () => {
  const r = extractBandwidthUnits('10 Gbps and 10 Gbps again');
  assert.equal(r.entries.filter((e) => e.kind === 'bandwidth').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `${i} Gbps `;
  const r = extractBandwidthUnits(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractBandwidthUnits('10 Gbps, 5 PB, 10K rps, 1M writes per day');
  assert.ok(r.totals.bandwidth >= 1);
  assert.ok(r.totals.storage >= 1);
  assert.ok(r.totals.rate >= 1);
  assert.ok(r.totals.volume >= 1);
});

test('buildBandwidthUnitsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '10 Gbps' },
    { name: 'b', extractedText: '5 PB' },
  ];
  const r = buildBandwidthUnitsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBandwidthUnitsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc', extractedText: '10 Gbps' }];
  const r = buildBandwidthUnitsForFiles(files);
  const md = renderBandwidthUnitsBlock(r);
  assert.match(md, /^## BANDWIDTH/);
});

test('renderBandwidthUnitsBlock empty when nothing surfaces', () => {
  assert.equal(renderBandwidthUnitsBlock({ perFile: [] }), '');
  assert.equal(renderBandwidthUnitsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBandwidthUnitsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '10 Gbps' },
  ]);
  assert.equal(r.perFile.length, 1);
});
