'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-legal-citations');
const { extractLegalCitations, buildLegalCitationsForFiles, renderLegalCitationsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractLegalCitations('').total, 0);
  assert.equal(extractLegalCitations(null).total, 0);
});

test('detects case name "Smith v. Jones"', () => {
  const r = extractLegalCitations('Cited Smith v. Jones today.');
  assert.ok(r.entries.some((e) => e.kind === 'case-name'));
});

test('detects "Brown v. Board of Education"', () => {
  const r = extractLegalCitations('Per Brown v. Board of Education ruling.');
  assert.ok(r.entries.some((e) => e.kind === 'case-name'));
});

test('detects reporter 123 U.S. 456', () => {
  const r = extractLegalCitations('See 123 U.S. 456 (1954) for the holding.');
  assert.ok(r.entries.some((e) => e.kind === 'reporter'));
});

test('detects F.2d reporter', () => {
  const r = extractLegalCitations('Per 412 F.2d 850 the rule applies.');
  assert.ok(r.entries.some((e) => e.kind === 'reporter'));
});

test('detects US Code 42 U.S.C. § 1983', () => {
  const r = extractLegalCitations('Under 42 U.S.C. § 1983 plaintiffs sued.');
  assert.ok(r.entries.some((e) => e.kind === 'us-code'));
});

test('detects CFR 29 C.F.R. § 1604', () => {
  const r = extractLegalCitations('Per 29 C.F.R. § 1604 regulation.');
  assert.ok(r.entries.some((e) => e.kind === 'cfr'));
});

test('detects Spanish "Ley 19/2013"', () => {
  const r = extractLegalCitations('Ver Ley 19/2013 sobre transparencia.');
  assert.ok(r.entries.some((e) => e.kind === 'es-statute'));
});

test('detects "Real Decreto 123/2020"', () => {
  const r = extractLegalCitations('Real Decreto 123/2020 establece.');
  assert.ok(r.entries.some((e) => e.kind === 'es-statute'));
});

test('dedupes identical citations', () => {
  const r = extractLegalCitations('Smith v. Jones first. Smith v. Jones again.');
  assert.equal(r.entries.filter((e) => /Smith/.test(e.value)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `${i + 100} U.S. ${i + 1} for. `;
  const r = extractLegalCitations(text);
  assert.ok(r.entries.length <= 18);
});

test('buildLegalCitationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Smith v. Jones' },
    { name: 'b.md', extractedText: '123 U.S. 456' },
  ];
  const r = buildLegalCitationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLegalCitationsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Smith v. Jones' }];
  const r = buildLegalCitationsForFiles(files);
  const md = renderLegalCitationsBlock(r);
  assert.match(md, /^## LEGAL CITATIONS/);
});

test('renderLegalCitationsBlock empty when nothing surfaces', () => {
  assert.equal(renderLegalCitationsBlock({ perFile: [] }), '');
  assert.equal(renderLegalCitationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLegalCitationsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Smith v. Jones' },
  ]);
  assert.equal(r.perFile.length, 1);
});
