'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ssn-pii');
const { extractSsnPii, buildSsnPiiForFiles, renderSsnPiiBlock, _internal } = engine;
const { mask } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSsnPii('').total, 0);
  assert.equal(extractSsnPii(null).total, 0);
});

test('mask: returns last-N format', () => {
  assert.equal(mask('123456789', 2), '*******89');
  assert.equal(mask('123456789', 4), '*****6789');
});

test('detects US SSN with label', () => {
  const r = extractSsnPii('SSN: 123-45-6789');
  assert.ok(r.entries.some((e) => e.kind === 'us-ssn'));
});

test('SSN output never contains full number', () => {
  const r = extractSsnPii('SSN: 123-45-6789');
  for (const e of r.entries) {
    assert.ok(!/123-45-6789/.test(e.masked));
    assert.ok(!/123456789/.test(e.masked));
  }
});

test('detects Spain DNI', () => {
  const r = extractSsnPii('DNI 12345678A registered');
  assert.ok(r.entries.some((e) => e.kind === 'es-dni'));
});

test('detects Spain NIE', () => {
  const r = extractSsnPii('NIE X1234567A foreigner');
  assert.ok(r.entries.some((e) => e.kind === 'es-nie'));
});

test('detects Mexico CURP', () => {
  const r = extractSsnPii('CURP: HEGG560427MQTRSL01');
  assert.ok(r.entries.some((e) => e.kind === 'mx-curp'));
});

test('detects Canada SIN with label', () => {
  const r = extractSsnPii('SIN: 123-456-789');
  assert.ok(r.entries.some((e) => e.kind === 'ca-sin'));
});

test('detects UK NINO', () => {
  const r = extractSsnPii('NI number AB123456C registered');
  assert.ok(r.entries.some((e) => e.kind === 'uk-nino'));
});

test('detects Brazil CPF', () => {
  const r = extractSsnPii('CPF: 123.456.789-01');
  assert.ok(r.entries.some((e) => e.kind === 'br-cpf'));
});

test('rejects bare 9-digit number without "SSN" label', () => {
  const r = extractSsnPii('Phone 555 123 4567 standalone');
  assert.equal(r.entries.filter((e) => e.kind === 'us-ssn').length, 0);
});

test('dedupes identical PII', () => {
  const r = extractSsnPii('SSN: 123-45-6789 here. SSN: 123-45-6789 again.');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `SSN: ${100 + i}-45-6789 `;
  const r = extractSsnPii(text);
  assert.ok(r.entries.length <= 12);
});

test('buildSsnPiiForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'SSN: 123-45-6789' },
    { name: 'b.md', extractedText: 'CPF: 123.456.789-01' },
  ];
  const r = buildSsnPiiForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSsnPiiBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'SSN: 123-45-6789' }];
  const r = buildSsnPiiForFiles(files);
  const md = renderSsnPiiBlock(r);
  assert.match(md, /^## NATIONAL ID/);
});

test('renderSsnPiiBlock NEVER contains the full number', () => {
  const files = [{ name: 'doc.md', extractedText: 'SSN: 123-45-6789' }];
  const r = buildSsnPiiForFiles(files);
  const md = renderSsnPiiBlock(r);
  assert.ok(!/123-45-6789/.test(md));
  assert.ok(!/123456789/.test(md));
});

test('renderSsnPiiBlock empty when nothing surfaces', () => {
  assert.equal(renderSsnPiiBlock({ perFile: [] }), '');
  assert.equal(renderSsnPiiBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSsnPiiForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'SSN: 123-45-6789' },
  ]);
  assert.equal(r.perFile.length, 1);
});
