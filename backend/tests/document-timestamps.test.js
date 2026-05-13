'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-timestamps');
const { extractTimestamps, buildTimestampsForFiles, renderTimestampsBlock, _internal } = engine;
const { isValidIsoDuration, isPlausibleEpoch } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTimestamps('').total, 0);
  assert.equal(extractTimestamps(null).total, 0);
});

test('isValidIsoDuration: PT alone / P alone invalid', () => {
  assert.equal(isValidIsoDuration('P'), false);
  assert.equal(isValidIsoDuration('PT'), false);
  assert.equal(isValidIsoDuration('PT1H'), true);
  assert.equal(isValidIsoDuration('P1Y'), true);
  assert.equal(isValidIsoDuration('P1Y2M3D'), true);
});

test('isPlausibleEpoch: 10-digit seconds', () => {
  assert.equal(isPlausibleEpoch('1709654400'), true);
  // Year < 2000 = invalid
  assert.equal(isPlausibleEpoch('0900000000'), false);
});

test('isPlausibleEpoch: 13-digit milliseconds', () => {
  assert.equal(isPlausibleEpoch('1709654400000'), true);
  assert.equal(isPlausibleEpoch('0123456'), false);
});

test('detects ISO datetime with Z', () => {
  const r = extractTimestamps('Event at 2024-03-15T08:30:00Z occurred.');
  assert.ok(r.items.some((it) => it.kind === 'iso-datetime' && it.value === '2024-03-15T08:30:00Z'));
});

test('detects ISO datetime with offset', () => {
  const r = extractTimestamps('Event at 2024-03-15T08:30:00.123-05:00 occurred.');
  assert.ok(r.items.some((it) => it.kind === 'iso-datetime'));
});

test('detects plain ISO date', () => {
  const r = extractTimestamps('Due: 2024-12-31 final.');
  assert.ok(r.items.some((it) => it.kind === 'iso-date'));
});

test('detects epoch prefixed', () => {
  const r = extractTimestamps('Event timestamp: 1709654400');
  assert.ok(r.items.some((it) => it.kind === 'epoch'));
});

test('ignores random 10-digit numbers without prefix', () => {
  const r = extractTimestamps('Phone is 5551234567 or similar.');
  assert.equal(r.items.filter((it) => it.kind === 'epoch').length, 0);
});

test('detects HTTP date', () => {
  const r = extractTimestamps('Last-Modified: Mon, 15 Mar 2024 08:30:00 GMT');
  assert.ok(r.items.some((it) => it.kind === 'http-date'));
});

test('detects ISO duration PT1H30M', () => {
  const r = extractTimestamps('SLA window is PT1H30M.');
  assert.ok(r.items.some((it) => it.kind === 'iso-duration' && it.value === 'PT1H30M'));
});

test('detects ISO duration P1Y', () => {
  const r = extractTimestamps('Retention period: P1Y');
  assert.ok(r.items.some((it) => it.kind === 'iso-duration' && it.value === 'P1Y'));
});

test('detects human duration "5 minutes"', () => {
  const r = extractTimestamps('Wait 5 minutes before retry.');
  assert.ok(r.items.some((it) => it.kind === 'human-duration' && /5\s*minutes/.test(it.value)));
});

test('detects human duration "2 days"', () => {
  const r = extractTimestamps('Allow 2 days for processing.');
  assert.ok(r.items.some((it) => it.kind === 'human-duration'));
});

test('detects short duration "30s"', () => {
  const r = extractTimestamps('Timeout: 30s default.');
  assert.ok(r.items.some((it) => it.kind === 'human-duration'));
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `Wait ${i + 1} minutes between retries. `;
  const r = extractTimestamps(text);
  assert.ok(r.totals['human-duration'] <= 8);
});

test('dedupes identical values', () => {
  const r = extractTimestamps('At 2024-03-15T08:30:00Z and again at 2024-03-15T08:30:00Z.');
  assert.equal(r.items.filter((it) => it.kind === 'iso-datetime').length, 1);
});

test('buildTimestampsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Event at 2024-03-15T08:30:00Z.' },
    { name: 'b.md', extractedText: 'Window PT1H30M' },
  ];
  const r = buildTimestampsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTimestampsBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: '2024-03-15T08:30:00Z event.' }];
  const r = buildTimestampsForFiles(files);
  const md = renderTimestampsBlock(r);
  assert.match(md, /^## TIMESTAMPS & DURATIONS/);
});

test('renderTimestampsBlock empty when nothing surfaces', () => {
  assert.equal(renderTimestampsBlock({ perFile: [] }), '');
  assert.equal(renderTimestampsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTimestampsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '2024-03-15T08:30:00Z' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('combines multiple kinds in single doc', () => {
  const text = 'Event at 2024-03-15T08:30:00Z, retention P1Y, wait 5 minutes between retries.';
  const r = extractTimestamps(text);
  const kinds = new Set(r.items.map((it) => it.kind));
  assert.ok(kinds.has('iso-datetime'));
  assert.ok(kinds.has('iso-duration'));
  assert.ok(kinds.has('human-duration'));
});
