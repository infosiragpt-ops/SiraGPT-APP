'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-data-classification');
const { extractClassification, buildClassificationForFiles, renderClassificationBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractClassification('').total, 0);
  assert.equal(extractClassification(null).total, 0);
});

test('detects CONFIDENTIAL', () => {
  const r = extractClassification('CONFIDENTIAL\nThe internal-only memo follows.');
  assert.ok(r.labels.some((l) => l.kind === 'confidential'));
});

test('detects RESTRICTED + INTERNAL ONLY', () => {
  const r = extractClassification('RESTRICTED. Internal Use Only.');
  const kinds = r.labels.map((l) => l.kind);
  assert.ok(kinds.includes('restricted'));
  assert.ok(kinds.includes('internal-only'));
});

test('detects Spanish CONFIDENCIAL', () => {
  const r = extractClassification('CONFIDENCIAL\nDocumento de uso interno.');
  assert.ok(r.labels.some((l) => l.kind === 'confidential'));
});

test('detects PII / PHI', () => {
  const r = extractClassification('PII protected. PHI handling per HIPAA.');
  const kinds = r.labels.map((l) => l.kind);
  assert.ok(kinds.includes('pii'));
  assert.ok(kinds.includes('phi'));
});

test('detects TLP labels', () => {
  const r1 = extractClassification('TLP:RED');
  const r2 = extractClassification('TLP: AMBER');
  const r3 = extractClassification('TLP-GREEN');
  assert.ok(r1.labels.some((l) => l.kind === 'tlp-red'));
  assert.ok(r2.labels.some((l) => l.kind === 'tlp-amber'));
  assert.ok(r3.labels.some((l) => l.kind === 'tlp-green'));
});

test('detects Trade Secret', () => {
  const r = extractClassification('TRADE SECRET MATERIAL');
  assert.ok(r.labels.some((l) => l.kind === 'trade-secret'));
});

test('scans head AND tail', () => {
  const head = 'PUBLIC\n';
  const body = 'irrelevant '.repeat(2000);
  const tail = '\nCONFIDENTIAL';
  const r = extractClassification(head + body + tail);
  const kinds = r.labels.map((l) => l.kind);
  assert.ok(kinds.includes('public'));
  assert.ok(kinds.includes('confidential'));
});

test('buildClassificationForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'CONFIDENTIAL\nContent.' },
    { name: 'b.md', extractedText: 'PUBLIC\nContent.' },
  ];
  const r = buildClassificationForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderClassificationBlock returns markdown when labels exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'CONFIDENTIAL\nContent.' }];
  const r = buildClassificationForFiles(files);
  const md = renderClassificationBlock(r);
  assert.match(md, /^## DATA CLASSIFICATION/);
});

test('renderClassificationBlock empty when nothing surfaces', () => {
  assert.equal(renderClassificationBlock({ perFile: [] }), '');
  assert.equal(renderClassificationBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildClassificationForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'CONFIDENTIAL' }]);
  assert.equal(r.perFile.length, 1);
});
