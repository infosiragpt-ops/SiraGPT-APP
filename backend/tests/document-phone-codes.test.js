'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-phone-codes');
const { extractPhoneCodes, buildPhoneCodesForFiles, renderPhoneCodesBlock, _internal } = engine;
const { matchedCountryCode } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractPhoneCodes('').total, 0);
  assert.equal(extractPhoneCodes(null).total, 0);
});

test('matchedCountryCode: +1 US', () => {
  const r = matchedCountryCode('+15551234567');
  assert.equal(r.code, '+1');
});

test('matchedCountryCode: +44 GB', () => {
  const r = matchedCountryCode('+442079460958');
  assert.equal(r.code, '+44');
});

test('matchedCountryCode: +52 MX', () => {
  const r = matchedCountryCode('+525512345678');
  assert.equal(r.code, '+52');
});

test('detects E.164 US number', () => {
  const r = extractPhoneCodes('Call us at +1 555 123 4567');
  assert.ok(r.entries.some((e) => e.countryCode === '+1'));
});

test('detects labeled phone:', () => {
  const r = extractPhoneCodes('phone: +44 20 7946 0958');
  assert.ok(r.entries.some((e) => e.countryCode === '+44'));
});

test('detects Spanish "móvil:"', () => {
  const r = extractPhoneCodes('Móvil: +34 612 345 678');
  assert.ok(r.entries.some((e) => e.countryCode === '+34'));
});

test('detects WhatsApp', () => {
  const r = extractPhoneCodes('WhatsApp +52 55 1234 5678');
  assert.ok(r.entries.some((e) => e.countryCode === '+52'));
});

test('dedupes identical numbers', () => {
  const r = extractPhoneCodes('Phone +1 555 1234 567 and again +1 555 1234 567');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `+1 555 ${(i + 100).toString().padStart(3, '0')} 1234 `;
  const r = extractPhoneCodes(text);
  assert.ok(r.entries.length <= 16);
});

test('buildPhoneCodesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '+1 555 1234567' },
    { name: 'b.md', extractedText: '+44 20 7946 0958' },
  ];
  const r = buildPhoneCodesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPhoneCodesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '+1 555 1234567' }];
  const r = buildPhoneCodesForFiles(files);
  const md = renderPhoneCodesBlock(r);
  assert.match(md, /^## PHONE COUNTRY CODES/);
});

test('renderPhoneCodesBlock empty when nothing surfaces', () => {
  assert.equal(renderPhoneCodesBlock({ perFile: [] }), '');
  assert.equal(renderPhoneCodesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPhoneCodesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '+1 555 1234567' },
  ]);
  assert.equal(r.perFile.length, 1);
});
