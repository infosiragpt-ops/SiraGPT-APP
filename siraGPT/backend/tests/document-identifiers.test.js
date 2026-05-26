'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-identifiers');
const { extractIdentifiers, buildIdentifiersForFiles, renderIdentifiersBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractIdentifiers('').total, 0);
  assert.equal(extractIdentifiers(null).total, 0);
});

test('detects ISBN-13', () => {
  const r = extractIdentifiers('ISBN: 978-3-16-148410-0');
  assert.ok(r.identifiers['ISBN-13'] && r.identifiers['ISBN-13'].length === 1);
});

test('detects DOI', () => {
  const r = extractIdentifiers('Reference: doi:10.1000/xyz123');
  assert.ok(r.identifiers.DOI && r.identifiers.DOI.length === 1);
});

test('detects DOI via URL', () => {
  const r = extractIdentifiers('See https://doi.org/10.1234/abcd.ef.5678');
  assert.ok(r.identifiers.DOI && r.identifiers.DOI.length === 1);
});

test('detects arXiv id', () => {
  const r = extractIdentifiers('Preprint at arXiv: 2401.12345v2');
  assert.ok(r.identifiers.arXiv && r.identifiers.arXiv.length === 1);
});

test('detects ticker', () => {
  const r = extractIdentifiers('NYSE: ACME and $TSLA today.');
  assert.ok(r.identifiers.ticker && r.identifiers.ticker.length >= 1);
});

test('detects UUID', () => {
  const r = extractIdentifiers('uuid: 550e8400-e29b-41d4-a716-446655440000');
  assert.ok(r.identifiers.UUID && r.identifiers.UUID.length === 1);
});

test('detects AWS ARN', () => {
  const r = extractIdentifiers('Resource: arn:aws:s3:::my-bucket/key.txt');
  assert.ok(r.identifiers['AWS-ARN'] && r.identifiers['AWS-ARN'].length === 1);
});

test('detects CVE', () => {
  const r = extractIdentifiers('Vulnerability: CVE-2024-12345');
  assert.ok(r.identifiers.CVE && r.identifiers.CVE.length === 1);
});

test('detects PMID', () => {
  const r = extractIdentifiers('PubMed ID: PMID: 12345678');
  assert.ok(r.identifiers.PMID && r.identifiers.PMID.length === 1);
});

test('caps results per kind per file', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `CVE-2024-1234${i} `;
  const r = extractIdentifiers(text);
  assert.ok(r.identifiers.CVE.length <= 6);
});

test('dedupes identical identifiers', () => {
  const r = extractIdentifiers('CVE-2024-1234 again CVE-2024-1234.');
  assert.equal(r.identifiers.CVE.length, 1);
});

test('buildIdentifiersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'CVE-2024-1234' },
    { name: 'b.md', extractedText: 'doi:10.1000/xyz' },
  ];
  const r = buildIdentifiersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderIdentifiersBlock returns markdown', () => {
  const files = [{ name: 'doc.md', extractedText: 'CVE-2024-1234' }];
  const r = buildIdentifiersForFiles(files);
  const md = renderIdentifiersBlock(r);
  assert.match(md, /^## DOCUMENT IDENTIFIERS/);
});

test('renderIdentifiersBlock empty when nothing surfaces', () => {
  assert.equal(renderIdentifiersBlock({ perFile: [] }), '');
  assert.equal(renderIdentifiersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildIdentifiersForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'CVE-2024-1234' }]);
  assert.equal(r.perFile.length, 1);
});
