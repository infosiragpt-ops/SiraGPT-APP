'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-postal-codes');
const { extractPostalCodes, buildPostalCodesForFiles, renderPostalCodesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPostalCodes('').total, 0);
  assert.equal(extractPostalCodes(null).total, 0);
});

test('detects UK postcode SW1A 1AA', () => {
  const r = extractPostalCodes('Buckingham Palace SW1A 1AA');
  assert.ok(r.entries.some((e) => e.kind === 'uk'));
});

test('detects Canada M5V 3A1', () => {
  const r = extractPostalCodes('Toronto M5V 3A1 area');
  assert.ok(r.entries.some((e) => e.kind === 'ca'));
});

test('detects Brazil CEP', () => {
  const r = extractPostalCodes('CEP 01310-100 São Paulo');
  assert.ok(r.entries.some((e) => e.kind === 'br'));
});

test('detects Japan 〒123-4567', () => {
  const r = extractPostalCodes('Address 〒100-0001 Tokyo');
  assert.ok(r.entries.some((e) => e.kind === 'jp'));
});

test('detects US ZIP+4', () => {
  const r = extractPostalCodes('Address 90210-1234 Beverly Hills');
  assert.ok(r.entries.some((e) => e.kind === 'us-zip4'));
});

test('detects labeled "ZIP code: 90210"', () => {
  const r = extractPostalCodes('ZIP code: 90210 in California');
  assert.ok(r.entries.some((e) => e.kind === 'labeled-zip'));
});

test('detects Spanish "código postal"', () => {
  const r = extractPostalCodes('Código postal: 28001 Madrid');
  assert.ok(r.entries.some((e) => e.kind === 'labeled-zip'));
});

test('detects "CP: 06600"', () => {
  const r = extractPostalCodes('CP: 06600 CDMX');
  assert.ok(r.entries.some((e) => e.kind === 'labeled-zip'));
});

test('detects "PLZ 10115"', () => {
  const r = extractPostalCodes('PLZ 10115 Berlin');
  assert.ok(r.entries.some((e) => e.kind === 'labeled-zip'));
});

test('dedupes identical codes', () => {
  const r = extractPostalCodes('SW1A 1AA in London. SW1A 1AA again.');
  assert.equal(r.entries.filter((e) => /SW1A/.test(e.code)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `ZIP: ${10000 + i} `;
  const r = extractPostalCodes(text);
  assert.ok(r.entries.length <= 16);
});

test('buildPostalCodesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'SW1A 1AA' },
    { name: 'b.md', extractedText: 'CEP 01310-100' },
  ];
  const r = buildPostalCodesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPostalCodesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'SW1A 1AA' }];
  const r = buildPostalCodesForFiles(files);
  const md = renderPostalCodesBlock(r);
  assert.match(md, /^## POSTAL/);
});

test('renderPostalCodesBlock empty when nothing surfaces', () => {
  assert.equal(renderPostalCodesBlock({ perFile: [] }), '');
  assert.equal(renderPostalCodesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPostalCodesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'SW1A 1AA' },
  ]);
  assert.equal(r.perFile.length, 1);
});
