'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-orcid-ids');
const { extractOrcidIds, buildOrcidIdsForFiles, renderOrcidIdsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractOrcidIds('').total, 0);
  assert.equal(extractOrcidIds(null).total, 0);
});

test('detects bare ORCID', () => {
  const r = extractOrcidIds('Author: 0000-0001-2345-6789');
  assert.ok(r.entries.some((e) => e.kind === 'orcid'));
});

test('detects ORCID with X check digit', () => {
  const r = extractOrcidIds('ORCID: 0000-0001-2345-678X');
  assert.ok(r.entries.some((e) => /678X/.test(e.id)));
});

test('detects labeled ORCID', () => {
  const r = extractOrcidIds('ORCID ID: 0000-0002-1825-0097');
  assert.ok(r.entries.some((e) => e.source === 'labeled' || e.source === 'bare'));
});

test('detects ORCID URL', () => {
  const r = extractOrcidIds('Profile: https://orcid.org/0000-0001-2345-6789');
  assert.ok(r.entries.some((e) => e.source === 'url'));
});

test('detects ResearcherID', () => {
  const r = extractOrcidIds('ResearcherID: A-1234-2025');
  assert.ok(r.entries.some((e) => e.kind === 'researcherId'));
});

test('detects Scopus Author ID', () => {
  const r = extractOrcidIds('Scopus Author ID: 12345678900');
  assert.ok(r.entries.some((e) => e.kind === 'scopus'));
});

test('detects Google Scholar profile URL', () => {
  const r = extractOrcidIds('https://scholar.google.com/citations?user=ABC123def456');
  assert.ok(r.entries.some((e) => e.kind === 'scholar'));
});

test('dedupes identical ORCIDs', () => {
  const r = extractOrcidIds('0000-0001-2345-6789 and 0000-0001-2345-6789 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += `0000-0001-2345-${i.toString().padStart(4, '0')} `;
  }
  const r = extractOrcidIds(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractOrcidIds(
    '0000-0001-2345-6789 and ResearcherID: A-1234-2025 and Scopus Author ID: 12345678900'
  );
  assert.ok(r.totals.orcid >= 1);
  assert.ok(r.totals.researcherId >= 1);
  assert.ok(r.totals.scopus >= 1);
});

test('buildOrcidIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: '0000-0001-2345-6789' },
    { name: 'b', extractedText: '0000-0002-1825-0097' },
  ];
  const r = buildOrcidIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderOrcidIdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'bio', extractedText: '0000-0001-2345-6789' }];
  const r = buildOrcidIdsForFiles(files);
  const md = renderOrcidIdsBlock(r);
  assert.match(md, /^## RESEARCH AUTHOR/);
});

test('renderOrcidIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderOrcidIdsBlock({ perFile: [] }), '');
  assert.equal(renderOrcidIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildOrcidIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '0000-0001-2345-6789' },
  ]);
  assert.equal(r.perFile.length, 1);
});
