'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-gene-protein');
const { extractGeneProtein, buildGeneProteinForFiles, renderGeneProteinBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractGeneProtein('').total, 0);
  assert.equal(extractGeneProtein(null).total, 0);
});

test('detects BRCA1 gene', () => {
  const r = extractGeneProtein('Mutation in BRCA1 gene observed.');
  assert.ok(r.entries.some((e) => e.kind === 'gene' && e.value === 'BRCA1'));
});

test('detects TP53', () => {
  const r = extractGeneProtein('TP53 is a tumor suppressor.');
  assert.ok(r.entries.some((e) => e.kind === 'gene' && e.value === 'TP53'));
});

test('detects EGFR', () => {
  const r = extractGeneProtein('EGFR signaling drives growth.');
  assert.ok(r.entries.some((e) => e.kind === 'gene'));
});

test('detects p53 protein', () => {
  const r = extractGeneProtein('The p53 protein is critical.');
  assert.ok(r.entries.some((e) => e.kind === 'protein-p'));
});

test('detects RefSeq mRNA NM_001234', () => {
  const r = extractGeneProtein('Transcript NM_001234 expressed.');
  assert.ok(r.entries.some((e) => e.kind === 'mrna'));
});

test('detects Ensembl ENST00000123456', () => {
  const r = extractGeneProtein('Used ENST00000123456 isoform.');
  assert.ok(r.entries.some((e) => e.kind === 'enst'));
});

test('detects rsID', () => {
  const r = extractGeneProtein('Variant rs12345 increases risk.');
  assert.ok(r.entries.some((e) => e.kind === 'rsid'));
});

test('rejects USA / API as genes', () => {
  const r = extractGeneProtein('Use the API in USA today.');
  assert.equal(r.entries.filter((e) => /USA|API/.test(e.value)).length, 0);
});

test('dedupes identical genes', () => {
  const r = extractGeneProtein('BRCA1 first. BRCA1 again.');
  assert.equal(r.entries.filter((e) => e.value === 'BRCA1').length, 1);
});

test('caps entries per file', () => {
  const r = extractGeneProtein('BRCA1 TP53 EGFR KRAS BRAF MYC PTEN APC RB1 NF1 NF2 VHL SMAD4 ALK RET MET ROS1 BCL2 BCL6 MYCN ' + 'word '.repeat(50));
  assert.ok(r.entries.length <= 20);
});

test('buildGeneProteinForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'BRCA1 study' },
    { name: 'b.md', extractedText: 'TP53 mutation' },
  ];
  const r = buildGeneProteinForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGeneProteinBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'BRCA1 study' }];
  const r = buildGeneProteinForFiles(files);
  const md = renderGeneProteinBlock(r);
  assert.match(md, /^## GENE \/ PROTEIN SYMBOLS/);
});

test('renderGeneProteinBlock empty when nothing surfaces', () => {
  assert.equal(renderGeneProteinBlock({ perFile: [] }), '');
  assert.equal(renderGeneProteinBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGeneProteinForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'BRCA1' },
  ]);
  assert.equal(r.perFile.length, 1);
});
