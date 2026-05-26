'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-section-labels');
const { extractSectionLabels, buildSectionLabelsForFiles, renderSectionLabelsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSectionLabels('').total, 0);
  assert.equal(extractSectionLabels(null).total, 0);
});

test('detects Section 1.2.3', () => {
  const r = extractSectionLabels('See Section 1.2.3 for details.');
  assert.ok(r.labels.some((l) => l.kind === 'section' && l.number === '1.2.3'));
});

test('detects Sec. 4', () => {
  const r = extractSectionLabels('Per Sec. 4, this applies.');
  assert.ok(r.labels.some((l) => l.kind === 'section'));
});

test('detects Spanish Sección', () => {
  const r = extractSectionLabels('Ver Sección 3 para detalles.');
  assert.ok(r.labels.some((l) => l.kind === 'section'));
});

test('detects § paragraph mark', () => {
  const r = extractSectionLabels('Per §12, this rule applies.');
  assert.ok(r.labels.some((l) => l.kind === 'paragraph'));
});

test('detects Chapter 4', () => {
  const r = extractSectionLabels('In Chapter 4 we discuss.');
  assert.ok(r.labels.some((l) => l.kind === 'chapter'));
});

test('detects Capítulo II Roman numeral', () => {
  const r = extractSectionLabels('Capítulo II describe el contexto.');
  assert.ok(r.labels.some((l) => l.kind === 'chapter' && l.number === 'II'));
});

test('detects Article 12', () => {
  const r = extractSectionLabels('Per Article 12, the rule applies.');
  assert.ok(r.labels.some((l) => l.kind === 'article'));
});

test('detects Artículo 5', () => {
  const r = extractSectionLabels('Artículo 5 establece esto.');
  assert.ok(r.labels.some((l) => l.kind === 'article'));
});

test('detects Part III', () => {
  const r = extractSectionLabels('Part III: enforcement provisions.');
  assert.ok(r.labels.some((l) => l.kind === 'part' && l.number === 'III'));
});

test('detects Annex B', () => {
  const r = extractSectionLabels('See Annex B for tables.');
  assert.ok(r.labels.some((l) => l.kind === 'annex'));
});

test('detects Appendix A', () => {
  const r = extractSectionLabels('Appendix A: glossary.');
  assert.ok(r.labels.some((l) => l.kind === 'appendix'));
});

test('detects Clause 3.1', () => {
  const r = extractSectionLabels('Per Clause 3.1, parties shall...');
  assert.ok(r.labels.some((l) => l.kind === 'clause'));
});

test('dedupes identical labels', () => {
  const r = extractSectionLabels('Section 1 here and Section 1 there.');
  assert.equal(r.labels.filter((l) => l.kind === 'section' && l.number === '1').length, 1);
});

test('caps per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `Section ${i + 1} info. `;
  const r = extractSectionLabels(text);
  assert.ok(r.labels.length <= 24);
});

test('counts byKind', () => {
  const r = extractSectionLabels('Section 1, Chapter 2, Article 3');
  assert.ok(r.byKind.section >= 1);
  assert.ok(r.byKind.chapter >= 1);
  assert.ok(r.byKind.article >= 1);
});

test('buildSectionLabelsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Section 1.2' },
    { name: 'b.md', extractedText: 'Article 3' },
  ];
  const r = buildSectionLabelsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSectionLabelsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'See Section 1.2' }];
  const r = buildSectionLabelsForFiles(files);
  const md = renderSectionLabelsBlock(r);
  assert.match(md, /^## SECTION \/ ARTICLE LABELS/);
});

test('renderSectionLabelsBlock empty when nothing surfaces', () => {
  assert.equal(renderSectionLabelsBlock({ perFile: [] }), '');
  assert.equal(renderSectionLabelsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSectionLabelsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Section 1' },
  ]);
  assert.equal(r.perFile.length, 1);
});
