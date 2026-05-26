'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-metadata-extractor');
const { extractMetadata, buildMetadataForFiles, renderMetadataBlock, _internal } = engine;
const { clean } = _internal;

test('empty / non-string input → empty metadata', () => {
  assert.deepEqual(extractMetadata(''), {});
  assert.deepEqual(extractMetadata(null), {});
});

test('clean strips wrapping punctuation and whitespace', () => {
  assert.equal(clean(': Jane Smith,'), 'Jane Smith');
});

test('detects English version stamp', () => {
  const r = extractMetadata('Version: 2.1\nAuthor: Jane Smith');
  assert.equal(r.version, '2.1');
});

test('detects Spanish version stamp', () => {
  const r = extractMetadata('Versión: 3.0\nAutor: Pérez');
  assert.equal(r.version, '3.0');
});

test('detects effective date', () => {
  const r = extractMetadata('Effective Date: 2026-05-12');
  assert.match(r.effective_date, /2026-05-12/);
});

test('detects Spanish effective date "fecha de vigencia"', () => {
  const r = extractMetadata('Fecha de vigencia: 2026-05-12');
  assert.match(r.effective_date, /2026-05-12/);
});

test('detects issued / last updated dates', () => {
  const r = extractMetadata('Issued: 2026-01-15\nLast updated: 2026-05-12');
  assert.match(r.issued_date, /2026-01-15/);
  assert.match(r.revision_date, /2026-05-12/);
});

test('detects author', () => {
  const r = extractMetadata('Prepared by: Acme Legal Team');
  assert.match(r.author, /Acme Legal Team/);
});

test('detects signed-by', () => {
  const r = extractMetadata('Signed by: Jane Smith, CEO');
  assert.match(r.signed_by, /Jane Smith/);
});

test('detects reference / document number', () => {
  const r = extractMetadata('Document No: ABC-123-2026');
  assert.match(r.reference_no, /ABC-123-2026/);
});

test('Spanish reference: "Referencia núm."', () => {
  const r = extractMetadata('Referencia núm.: XYZ-77');
  assert.match(r.reference_no, /XYZ-77/);
});

test('buildMetadataForFiles aggregates across files', () => {
  const files = [
    { name: 'spec.md', extractedText: 'Version: 1.2\nIssued: 2026-04-01' },
    { name: 'contract.md', extractedText: 'Effective Date: 2026-05-12\nSigned by: Maria Lopez' },
  ];
  const r = buildMetadataForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMetadataBlock returns markdown when metadata exists', () => {
  const files = [{ name: 'doc.md', extractedText: 'Version: 2.1\nAuthor: Jane Smith' }];
  const r = buildMetadataForFiles(files);
  const md = renderMetadataBlock(r);
  assert.match(md, /^## DOCUMENT METADATA/);
  assert.match(md, /Jane Smith/);
});

test('renderMetadataBlock empty when nothing surfaces', () => {
  assert.equal(renderMetadataBlock({ perFile: [] }), '');
  assert.equal(renderMetadataBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMetadataForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Version: 1.0' }]);
  assert.equal(r.perFile.length, 1);
});
