'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-standards');
const { extractStandards, buildStandardsForFiles, renderStandardsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractStandards('').total, 0);
  assert.equal(extractStandards(null).total, 0);
});

test('detects ISO 9001', () => {
  const r = extractStandards('Certified to ISO 9001 yearly.');
  assert.ok(r.standards.some((s) => s.kind === 'ISO' && /9001/.test(s.value)));
});

test('detects ISO/IEC 27001:2022', () => {
  const r = extractStandards('Compliant with ISO/IEC 27001:2022 standard.');
  assert.ok(r.standards.some((s) => s.kind === 'ISO' && /27001/.test(s.value)));
});

test('detects ANSI standards', () => {
  const r = extractStandards('Per ANSI Y14.5 dimensioning.');
  assert.ok(r.standards.some((s) => s.kind === 'ANSI'));
});

test('detects IEEE 802.11', () => {
  const r = extractStandards('Wi-Fi standard IEEE 802.11ax');
  assert.ok(r.standards.some((s) => s.kind === 'IEEE'));
});

test('detects RFC 7231', () => {
  const r = extractStandards('HTTP semantics in RFC 7231.');
  assert.ok(r.standards.some((s) => s.kind === 'RFC' && s.value === '7231'));
});

test('detects NIST SP 800-53', () => {
  const r = extractStandards('Aligned with NIST SP 800-53 controls.');
  assert.ok(r.standards.some((s) => s.kind === 'NIST'));
});

test('detects W3C standards', () => {
  const r = extractStandards('Per W3C HTML5 specification.');
  assert.ok(r.standards.some((s) => s.kind === 'W3C'));
});

test('detects GDPR', () => {
  const r = extractStandards('Per GDPR Art. 15.');
  assert.ok(r.standards.some((s) => s.kind === 'compliance' && s.value === 'GDPR'));
});

test('detects HIPAA', () => {
  const r = extractStandards('HIPAA Privacy Rule applies.');
  assert.ok(r.standards.some((s) => s.kind === 'compliance' && s.value === 'HIPAA'));
});

test('detects PCI-DSS', () => {
  const r = extractStandards('PCI-DSS v4.0 certification.');
  assert.ok(r.standards.some((s) => s.kind === 'PCI'));
});

test('detects SOC 2 Type II', () => {
  const r = extractStandards('SOC 2 Type II audit complete.');
  assert.ok(r.standards.some((s) => s.kind === 'SOC'));
});

test('dedupes identical entries', () => {
  const r = extractStandards('ISO 9001 here and ISO 9001 there.');
  assert.equal(r.standards.filter((s) => s.kind === 'ISO' && /9001/.test(s.value)).length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += `ISO ${9000 + i} `;
  const r = extractStandards(text);
  assert.ok(r.byKind.ISO <= 10);
});

test('counts byKind', () => {
  const r = extractStandards('ISO 9001 and RFC 7231 and GDPR');
  assert.ok(r.byKind.ISO >= 1);
  assert.ok(r.byKind.RFC >= 1);
  assert.ok(r.byKind.compliance >= 1);
});

test('buildStandardsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'ISO 9001' },
    { name: 'b.md', extractedText: 'RFC 7231' },
  ];
  const r = buildStandardsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderStandardsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'ISO 9001' }];
  const r = buildStandardsForFiles(files);
  const md = renderStandardsBlock(r);
  assert.match(md, /^## STANDARDS \/ SPECIFICATIONS/);
});

test('renderStandardsBlock empty when nothing surfaces', () => {
  assert.equal(renderStandardsBlock({ perFile: [] }), '');
  assert.equal(renderStandardsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildStandardsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'ISO 9001' },
  ]);
  assert.equal(r.perFile.length, 1);
});
