'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-tracking-numbers');
const { extractTrackingNumbers, buildTrackingNumbersForFiles, renderTrackingNumbersBlock, _internal } = engine;
const { maskTracking } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractTrackingNumbers('').total, 0);
  assert.equal(extractTrackingNumbers(null).total, 0);
});

test('maskTracking: first-4 last-4', () => {
  assert.equal(maskTracking('1Z999AA10123456784'), '1Z99…6784');
});

test('detects UPS tracking number', () => {
  const r = extractTrackingNumbers('Tracking: 1Z999AA10123456784');
  assert.ok(r.entries.some((e) => e.carrier === 'ups'));
});

test('UPS number is masked', () => {
  const r = extractTrackingNumbers('1Z999AA10123456784');
  for (const e of r.entries) {
    assert.ok(!/1Z999AA10123456784/.test(e.masked));
  }
});

test('detects Amazon TBA tracking', () => {
  const r = extractTrackingNumbers('TBA123456789012 delivered today.');
  assert.ok(r.entries.some((e) => e.carrier === 'amazon'));
});

test('detects USPS tracking', () => {
  const r = extractTrackingNumbers('9405 5036 9930 0000 0000 00 was sent.');
  assert.ok(r.entries.some((e) => e.carrier === 'usps'));
});

test('detects DHL labeled tracking', () => {
  const r = extractTrackingNumbers('DHL: 1234567890');
  assert.ok(r.entries.some((e) => e.carrier === 'dhl'));
});

test('detects FedEx 12-digit', () => {
  const r = extractTrackingNumbers('FedEx tracking 123456789012');
  assert.ok(r.entries.some((e) => e.carrier === 'fedex' || e.carrier === 'dhl'));
});

test('detects FedEx 15-digit', () => {
  const r = extractTrackingNumbers('Tracking number 123456789012345');
  assert.ok(r.entries.some((e) => e.carrier === 'fedex'));
});

test('detects Canada Post 16-digit', () => {
  const r = extractTrackingNumbers('Canada Post: 1234567890123456');
  assert.ok(r.entries.some((e) => e.carrier === 'canadaPost'));
});

test('dedupes identical numbers', () => {
  const r = extractTrackingNumbers('1Z999AA10123456784 here and 1Z999AA10123456784 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 20; i++) {
    text += `1Z999AA1012345${i.toString().padStart(4, '0')} `;
  }
  const r = extractTrackingNumbers(text);
  assert.ok(r.entries.length <= 12);
});

test('counts totals by carrier', () => {
  const r = extractTrackingNumbers(
    '1Z999AA10123456784 and TBA123456789012 and DHL: 1234567890'
  );
  assert.ok(r.totals.ups >= 1);
  assert.ok(r.totals.amazon >= 1);
  assert.ok(r.totals.dhl >= 1);
});

test('buildTrackingNumbersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '1Z999AA10123456784' },
    { name: 'b', extractedText: 'TBA123456789012' },
  ];
  const r = buildTrackingNumbersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderTrackingNumbersBlock NEVER contains full UPS number', () => {
  const files = [{ name: 'order', extractedText: '1Z999AA10123456784' }];
  const r = buildTrackingNumbersForFiles(files);
  const md = renderTrackingNumbersBlock(r);
  assert.ok(!/1Z999AA10123456784/.test(md));
});

test('renderTrackingNumbersBlock empty when nothing surfaces', () => {
  assert.equal(renderTrackingNumbersBlock({ perFile: [] }), '');
  assert.equal(renderTrackingNumbersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTrackingNumbersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '1Z999AA10123456784' },
  ]);
  assert.equal(r.perFile.length, 1);
});
