'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-addresses');
const { extractAddresses, buildAddressesForFiles, renderAddressesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractAddresses('').total, 0);
  assert.equal(extractAddresses(null).total, 0);
});

test('detects US "123 Main St"', () => {
  const r = extractAddresses('Visit 123 Main St in Springfield.');
  assert.ok(r.entries.some((e) => e.kind === 'us-en'));
});

test('detects "456 Oak Avenue, Suite 200"', () => {
  const r = extractAddresses('Office at 456 Oak Avenue, Suite 200 today.');
  assert.ok(r.entries.some((e) => e.kind === 'us-en'));
});

test('detects Spanish "Calle Mayor 12"', () => {
  const r = extractAddresses('Sede en Calle Mayor 12, Madrid.');
  assert.ok(r.entries.some((e) => e.kind === 'es'));
});

test('detects "Avenida Constitución 25"', () => {
  const r = extractAddresses('Oficina en Avenida Constitución 25, 3ºB.');
  assert.ok(r.entries.some((e) => e.kind === 'es'));
});

test('detects PO Box', () => {
  const r = extractAddresses('Mail to P.O. Box 12345 in Springfield.');
  assert.ok(r.entries.some((e) => e.kind === 'po-box'));
});

test('detects "Apartado Postal"', () => {
  const r = extractAddresses('Enviar al Apartado Postal 567 en CDMX.');
  assert.ok(r.entries.some((e) => e.kind === 'po-box'));
});

test('detects labeled "address: ..."', () => {
  const r = extractAddresses('address: 123 Main St, Springfield, IL 62701');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('detects Spanish "dirección:"', () => {
  const r = extractAddresses('Dirección: Calle Mayor 12, 28001 Madrid');
  assert.ok(r.entries.some((e) => e.kind === 'labeled'));
});

test('dedupes identical addresses', () => {
  const r = extractAddresses('Visit 123 Main St here. Visit 123 Main St again.');
  assert.equal(r.entries.filter((e) => /123 Main/.test(e.value)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `${i + 100} Main St ${i}. `;
  const r = extractAddresses(text);
  assert.ok(r.entries.length <= 12);
});

test('buildAddressesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '123 Main St' },
    { name: 'b.md', extractedText: 'Calle Mayor 12' },
  ];
  const r = buildAddressesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAddressesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '123 Main St' }];
  const r = buildAddressesForFiles(files);
  const md = renderAddressesBlock(r);
  assert.match(md, /^## ADDRESSES/);
});

test('renderAddressesBlock empty when nothing surfaces', () => {
  assert.equal(renderAddressesBlock({ perFile: [] }), '');
  assert.equal(renderAddressesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAddressesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '123 Main St' },
  ]);
  assert.equal(r.perFile.length, 1);
});
