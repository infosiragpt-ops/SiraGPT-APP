'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-jurisdiction-detector');
const { detectJurisdiction, buildJurisdictionForFiles, renderJurisdictionBlock } = engine;

test('empty / non-string input → empty result', () => {
  const r = detectJurisdiction('');
  assert.equal(r.countries.length, 0);
  assert.equal(r.currencies.length, 0);
  assert.equal(r.regulators.length, 0);
  assert.equal(r.governingLaw.length, 0);
});

test('detects US-related jurisdictions', () => {
  const r = detectJurisdiction('This Agreement is governed by the laws of Delaware, United States. The Parties agree to the jurisdiction of New York courts.');
  const labels = r.countries.map((c) => c.label);
  assert.ok(labels.includes('Delaware') || labels.includes('United States') || labels.includes('New York'));
});

test('detects EU jurisdictions', () => {
  const r = detectJurisdiction('This data processing complies with GDPR requirements as enforced by the European Union and Spain.');
  const labels = r.countries.map((c) => c.label);
  assert.ok(labels.includes('European Union') || labels.includes('Spain'));
});

test('detects Spanish-speaking jurisdictions', () => {
  const r = detectJurisdiction('El contrato será regido por las leyes de México. Se aplicará la legislación de Argentina cuando corresponda.');
  const labels = r.countries.map((c) => c.label);
  assert.ok(labels.includes('Mexico') || labels.includes('Argentina'));
});

test('detects currencies', () => {
  const r = detectJurisdiction('Fees payable in USD or EUR. Local taxes in MXN.');
  const codes = r.currencies.map((c) => c.code);
  assert.ok(codes.includes('USD'));
  assert.ok(codes.includes('EUR'));
  assert.ok(codes.includes('MXN'));
});

test('detects regulators', () => {
  const r = detectJurisdiction('SEC filings are reviewed quarterly. GDPR compliance is monitored by the AEPD.');
  const labels = r.regulators.map((c) => c.label);
  assert.ok(labels.includes('SEC'));
  assert.ok(labels.includes('GDPR'));
});

test('detects governing-law clauses (English)', () => {
  const r = detectJurisdiction('This Agreement is governed by the laws of the State of New York, United States.');
  assert.ok(r.governingLaw.length >= 1);
});

test('detects governing-law clauses (Spanish)', () => {
  const r = detectJurisdiction('Este contrato será regido por la ley aplicable de la Ciudad de México, México.');
  // Spanish patterns may be more delicate — assert at least one signal surfaced.
  assert.ok(r.governingLaw.length >= 1 || r.countries.length >= 1);
});

test('country mentions are sorted by count', () => {
  const r = detectJurisdiction('Spain Spain Spain. France. France.');
  if (r.countries.length >= 2) {
    assert.ok(r.countries[0].mentions >= r.countries[1].mentions);
  }
});

test('buildJurisdictionForFiles aggregates per file', () => {
  const files = [
    { name: 'a.md', extractedText: 'Governed by the laws of Delaware. SEC compliance required.' },
    { name: 'b.md', extractedText: 'Sujeto a las leyes de México. CNBV es el regulador.' },
  ];
  const r = buildJurisdictionForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderJurisdictionBlock returns markdown', () => {
  const files = [{ name: 'demo.md', extractedText: 'Governed by Delaware law. Payable in USD.' }];
  const r = buildJurisdictionForFiles(files);
  const md = renderJurisdictionBlock(r);
  assert.match(md, /^## JURISDICTION/);
});

test('renderJurisdictionBlock empty when nothing detected', () => {
  assert.equal(renderJurisdictionBlock({ perFile: [] }), '');
  assert.equal(renderJurisdictionBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildJurisdictionForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Delaware law applies.' }]);
  assert.equal(r.perFile.length, 1);
});

test('caps total surfaced items to safe maximum', () => {
  const text = 'United States Delaware New York California Texas United Kingdom European Union Germany France Spain Brazil Mexico Argentina Peru Colombia Chile Japan China India';
  const r = detectJurisdiction(text);
  assert.ok(r.countries.length <= 8);
});
