'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tracking');
const { extractTracking, buildTrackingForFiles, renderTrackingBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractTracking('').total, 0);
  assert.equal(extractTracking(null).total, 0);
});

test('detects UPS 1Z prefix', () => {
  const r = extractTracking('Shipped via UPS 1Z999AA10123456784 today.');
  assert.ok(r.entries.some((e) => e.kind === 'ups'));
});

test('detects FedEx 12-digit', () => {
  const r = extractTracking('FedEx tracking 123456789012 dispatched.');
  assert.ok(r.entries.some((e) => e.kind === 'fedex'));
});

test('detects labeled tracking number', () => {
  const r = extractTracking('Tracking number: ABC123XYZ7890');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('detects Spanish "número de seguimiento"', () => {
  const r = extractTracking('Número de seguimiento: ABC123XYZ7890');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('dedupes identical codes', () => {
  const r = extractTracking('UPS 1Z999AA10123456784 sent. UPS 1Z999AA10123456784 confirmed.');
  assert.equal(r.entries.filter((e) => e.kind === 'ups').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `1Z999AA101234567${(i + 10).toString().padStart(2, '0')} `;
  const r = extractTracking(text);
  assert.ok(r.entries.length <= 16);
});

test('buildTrackingForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'UPS 1Z999AA10123456784' },
    { name: 'b.md', extractedText: 'Tracking: ABC123XYZ7890' },
  ];
  const r = buildTrackingForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTrackingBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'UPS 1Z999AA10123456784' }];
  const r = buildTrackingForFiles(files);
  const md = renderTrackingBlock(r);
  assert.match(md, /^## SHIPPING/);
});

test('renderTrackingBlock empty when nothing surfaces', () => {
  assert.equal(renderTrackingBlock({ perFile: [] }), '');
  assert.equal(renderTrackingBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTrackingForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'UPS 1Z999AA10123456784' },
  ]);
  assert.equal(r.perFile.length, 1);
});
