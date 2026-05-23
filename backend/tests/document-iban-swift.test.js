'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-iban-swift');
const { extractIbanSwift, buildIbanSwiftForFiles, renderIbanSwiftBlock, _internal } = engine;
const { isLikelyIBAN } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractIbanSwift('').total, 0);
  assert.equal(extractIbanSwift(null).total, 0);
});

test('isLikelyIBAN: valid forms', () => {
  assert.equal(isLikelyIBAN('DE89370400440532013000'), true);
  assert.equal(isLikelyIBAN('ES7921000418401234567891'), true);
  assert.equal(isLikelyIBAN('XX9999999999999999999'), false);
});

test('detects IBAN German', () => {
  const r = extractIbanSwift('Pay to DE89370400440532013000 today.');
  assert.ok(r.entries.some((e) => e.kind === 'iban'));
});

test('detects IBAN Spanish', () => {
  const r = extractIbanSwift('Cuenta: ES7921000418401234567891');
  assert.ok(r.entries.some((e) => e.kind === 'iban'));
});

test('detects SWIFT/BIC 8-char', () => {
  const r = extractIbanSwift('SWIFT: DEUTDEFF for international.');
  assert.ok(r.entries.some((e) => e.kind === 'swift'));
});

test('detects SWIFT/BIC 11-char', () => {
  const r = extractIbanSwift('Use BNPAFRPPXXX for that branch.');
  assert.ok(r.entries.some((e) => e.kind === 'swift'));
});

test('detects ABA routing', () => {
  const r = extractIbanSwift('Routing number 021000021 active.');
  assert.ok(r.entries.some((e) => e.kind === 'aba'));
});

test('detects CLABE Mexico', () => {
  const r = extractIbanSwift('CLABE: 014180001234567890');
  assert.ok(r.entries.some((e) => e.kind === 'clabe'));
});

test('rejects invalid IBAN country code', () => {
  const r = extractIbanSwift('Try ZZ123456789012345 invalid.');
  assert.equal(r.entries.filter((e) => e.kind === 'iban').length, 0);
});

test('dedupes identical codes', () => {
  const r = extractIbanSwift('DEUTDEFF here and DEUTDEFF there.');
  assert.equal(r.entries.filter((e) => e.code === 'DEUTDEFF').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `DEUTDE${i.toString().padStart(2, '0')} `;
  const r = extractIbanSwift(text);
  assert.ok(r.entries.length <= 16);
});

test('buildIbanSwiftForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'DEUTDEFF' },
    { name: 'b.md', extractedText: 'DE89370400440532013000' },
  ];
  const r = buildIbanSwiftForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIbanSwiftBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'DEUTDEFF' }];
  const r = buildIbanSwiftForFiles(files);
  const md = renderIbanSwiftBlock(r);
  assert.match(md, /^## BANKING CODES/);
});

test('renderIbanSwiftBlock empty when nothing surfaces', () => {
  assert.equal(renderIbanSwiftBlock({ perFile: [] }), '');
  assert.equal(renderIbanSwiftBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIbanSwiftForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'DEUTDEFF' },
  ]);
  assert.equal(r.perFile.length, 1);
});
