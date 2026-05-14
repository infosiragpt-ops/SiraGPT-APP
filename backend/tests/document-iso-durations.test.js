'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-iso-durations');
const { extractIsoDurations, buildIsoDurationsForFiles, renderIsoDurationsBlock, _internal } = engine;
const { toSeconds, classifyDuration } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractIsoDurations('').total, 0);
  assert.equal(extractIsoDurations(null).total, 0);
});

test('toSeconds: 1h 30m = 5400s', () => {
  assert.equal(toSeconds([null, null, null, null, '1', '30', null]), 5400);
});

test('classifyDuration buckets', () => {
  assert.equal(classifyDuration(30), 'sub-minute');
  assert.equal(classifyDuration(120), 'minutes');
  assert.equal(classifyDuration(7200), 'hours');
  assert.equal(classifyDuration(259200), 'days');
});

test('detects PT1H30M', () => {
  const r = extractIsoDurations('Timeout: PT1H30M');
  assert.ok(r.entries.some((e) => e.duration === 'PT1H30M'));
});

test('detects PT15M', () => {
  const r = extractIsoDurations('Retry after PT15M');
  assert.ok(r.entries.some((e) => e.duration === 'PT15M'));
});

test('detects P3DT12H', () => {
  const r = extractIsoDurations('Hold for P3DT12H');
  assert.ok(r.entries.some((e) => e.duration === 'P3DT12H'));
});

test('detects P1W', () => {
  const r = extractIsoDurations('Refresh interval P1W');
  assert.ok(r.entries.some((e) => e.duration === 'P1W'));
});

test('detects P1Y6M', () => {
  const r = extractIsoDurations('Reservation lasts P1Y6M');
  assert.ok(r.entries.some((e) => e.duration === 'P1Y6M'));
});

test('computes seconds for PT1H', () => {
  const r = extractIsoDurations('PT1H');
  const entry = r.entries.find((e) => e.duration === 'PT1H');
  assert.equal(entry.seconds, 3600);
});

test('detects decimal duration PT0.5H', () => {
  const r = extractIsoDurations('Wait PT0.5H');
  assert.ok(r.entries.some((e) => e.duration === 'PT0.5H'));
});

test('dedupes identical durations', () => {
  const r = extractIsoDurations('PT15M then PT15M');
  assert.equal(r.entries.filter((e) => e.duration === 'PT15M').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `PT${i}M `;
  const r = extractIsoDurations(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by bucket', () => {
  const r = extractIsoDurations('PT30S and PT15M and PT5H and P3D');
  assert.ok(r.totals['sub-minute'] >= 1);
  assert.ok(r.totals.minutes >= 1);
  assert.ok(r.totals.hours >= 1);
  assert.ok(r.totals.days >= 1);
});

test('buildIsoDurationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'PT15M' },
    { name: 'b', extractedText: 'P1D' },
  ];
  const r = buildIsoDurationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIsoDurationsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'config', extractedText: 'PT1H30M' }];
  const r = buildIsoDurationsForFiles(files);
  const md = renderIsoDurationsBlock(r);
  assert.match(md, /^## ISO 8601/);
});

test('renderIsoDurationsBlock empty when nothing surfaces', () => {
  assert.equal(renderIsoDurationsBlock({ perFile: [] }), '');
  assert.equal(renderIsoDurationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIsoDurationsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'PT15M' },
  ]);
  assert.equal(r.perFile.length, 1);
});
