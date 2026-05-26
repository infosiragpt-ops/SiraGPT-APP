'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-vin-numbers');
const { extractVinNumbers, buildVinNumbersForFiles, renderVinNumbersBlock, _internal } = engine;
const { maskVin, looksLikeVin } = _internal;

const VALID_VIN = '1HGBH41JXMN109186'; // 17 chars, no I/O/Q

test('empty / non-string tolerated', () => {
  assert.equal(extractVinNumbers('').total, 0);
  assert.equal(extractVinNumbers(null).total, 0);
});

test('maskVin: first-3 last-4', () => {
  assert.equal(maskVin(VALID_VIN), '1HG…9186');
});

test('looksLikeVin rejects forbidden letters', () => {
  assert.equal(looksLikeVin(VALID_VIN), true);
  assert.equal(looksLikeVin('1HGBH41JXMN1O9186'), false); // contains O
  assert.equal(looksLikeVin('1HGBH41JXMI109186'), false); // contains I
});

test('detects bare 17-char VIN', () => {
  const r = extractVinNumbers(`Vehicle ${VALID_VIN}`);
  assert.ok(r.entries.length >= 1);
});

test('detects "VIN: ..."', () => {
  const r = extractVinNumbers(`VIN: ${VALID_VIN}`);
  assert.ok(r.entries.some((e) => e.source === 'labeled'));
});

test('VIN is masked', () => {
  const r = extractVinNumbers(VALID_VIN);
  for (const e of r.entries) {
    assert.ok(!new RegExp(VALID_VIN).test(e.masked));
  }
});

test('captures WMI prefix', () => {
  const r = extractVinNumbers(VALID_VIN);
  assert.equal(r.entries[0].wmi, '1HG');
});

test('decodes year (approximate)', () => {
  const r = extractVinNumbers(VALID_VIN);
  assert.ok(r.entries[0].year != null);
});

test('rejects shorter strings', () => {
  const r = extractVinNumbers('1HGBH41JXMN10918'); // 16 chars
  assert.equal(r.entries.length, 0);
});

test('dedupes identical VINs', () => {
  const r = extractVinNumbers(`${VALID_VIN} and ${VALID_VIN} again`);
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  const base = '1HGBH41JXMN10000';
  for (let i = 1; i <= 15; i++) text += `${base}${i % 10} `;
  const r = extractVinNumbers(text);
  assert.ok(r.entries.length <= 12);
});

test('buildVinNumbersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: VALID_VIN },
    { name: 'b', extractedText: '1HGBH41JXMN109187' },
  ];
  const r = buildVinNumbersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderVinNumbersBlock NEVER contains full VIN', () => {
  const files = [{ name: 'reg.md', extractedText: VALID_VIN }];
  const r = buildVinNumbersForFiles(files);
  const md = renderVinNumbersBlock(r);
  assert.ok(!new RegExp(VALID_VIN).test(md));
});

test('renderVinNumbersBlock empty when nothing surfaces', () => {
  assert.equal(renderVinNumbersBlock({ perFile: [] }), '');
  assert.equal(renderVinNumbersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildVinNumbersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: VALID_VIN },
  ]);
  assert.equal(r.perFile.length, 1);
});
