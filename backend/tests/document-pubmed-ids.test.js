'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pubmed-ids');
const { extractPubmedIds, buildPubmedIdsForFiles, renderPubmedIdsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPubmedIds('').total, 0);
  assert.equal(extractPubmedIds(null).total, 0);
});

test('detects PMID labeled', () => {
  const r = extractPubmedIds('PMID: 32837500');
  assert.ok(r.entries.some((e) => e.kind === 'pmid'));
});

test('detects pubmed.ncbi URL', () => {
  const r = extractPubmedIds('https://pubmed.ncbi.nlm.nih.gov/32837500');
  assert.ok(r.entries.some((e) => e.kind === 'pmid' && e.source === 'url'));
});

test('detects legacy ncbi pubmed URL', () => {
  const r = extractPubmedIds('https://www.ncbi.nlm.nih.gov/pubmed/12345678');
  assert.ok(r.entries.some((e) => e.kind === 'pmid'));
});

test('detects PMC ID', () => {
  const r = extractPubmedIds('Full text: PMC1234567');
  assert.ok(r.entries.some((e) => e.kind === 'pmc'));
});

test('detects NCBI accession (NM_)', () => {
  const r = extractPubmedIds('mRNA reference: NM_000123.4');
  assert.ok(r.entries.some((e) => e.kind === 'ncbi'));
});

test('detects NCBI XP_ (protein)', () => {
  const r = extractPubmedIds('Protein XP_012345 from NCBI');
  assert.ok(r.entries.some((e) => e.kind === 'ncbi'));
});

test('detects NCT trial ID', () => {
  const r = extractPubmedIds('See NCT01234567 trial');
  assert.ok(r.entries.some((e) => e.kind === 'nct'));
});

test('detects dbSNP rs ID', () => {
  const r = extractPubmedIds('Variant rs12345678 is associated with...');
  assert.ok(r.entries.some((e) => e.kind === 'rs'));
});

test('rejects too-short rs IDs', () => {
  const r = extractPubmedIds('rs1 variant');
  assert.equal(r.entries.filter((e) => e.kind === 'rs').length, 0);
});

test('dedupes identical IDs', () => {
  const r = extractPubmedIds('PMID: 32837500 here and PMID: 32837500 again');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `PMID: ${10000000 + i} `;
  const r = extractPubmedIds(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractPubmedIds('PMID: 32837500, PMC1234567, NM_000123, NCT01234567, rs12345678');
  assert.ok(r.totals.pmid >= 1);
  assert.ok(r.totals.pmc >= 1);
  assert.ok(r.totals.ncbi >= 1);
  assert.ok(r.totals.nct >= 1);
  assert.ok(r.totals.rs >= 1);
});

test('buildPubmedIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'PMID: 32837500' },
    { name: 'b', extractedText: 'PMC1234567' },
  ];
  const r = buildPubmedIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPubmedIdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'paper', extractedText: 'PMID: 32837500' }];
  const r = buildPubmedIdsForFiles(files);
  const md = renderPubmedIdsBlock(r);
  assert.match(md, /^## NIH/);
});

test('renderPubmedIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderPubmedIdsBlock({ perFile: [] }), '');
  assert.equal(renderPubmedIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPubmedIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'PMID: 32837500' },
  ]);
  assert.equal(r.perFile.length, 1);
});
