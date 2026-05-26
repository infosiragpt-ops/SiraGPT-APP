'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-quality-grade');
const { gradeDocument, buildGradesForFiles, renderGradeBlock, _internal } = engine;
const { letterFor, structureScore, densityScore, freshnessScore, completenessScore } = _internal;

test('empty / non-string input returns F with zero score', () => {
  const g = gradeDocument('');
  assert.equal(g.letter, 'F');
  assert.equal(g.score, 0);
  assert.equal(gradeDocument(null).letter, 'F');
});

test('letterFor maps thresholds correctly', () => {
  assert.equal(letterFor(0.9), 'A');
  assert.equal(letterFor(0.75), 'B');
  assert.equal(letterFor(0.6), 'C');
  assert.equal(letterFor(0.45), 'D');
  assert.equal(letterFor(0.2), 'F');
});

test('structureScore: higher for well-structured text', () => {
  const text = `# Section A
- bullet 1
- bullet 2
1. numbered 1
2. numbered 2
| col | col |
| --- | --- |
| a | b |`;
  const score = structureScore(text);
  assert.ok(score > 0.2, `expected structure score > 0.2, got ${score}`);
});

test('densityScore: higher when facts dense', () => {
  const dense = 'Acme Corp grew 32% YoY to $4.2M on 2026-06-15. NPS climbed to 47.';
  const sparse = 'Today was a nice day at the office. The team had lunch and went home.';
  assert.ok(densityScore(dense) > densityScore(sparse));
});

test('freshnessScore: more recent years score higher', () => {
  const fresh = 'The report covers 2026 trends. Q1 2026 was strong.';
  const stale = 'The report covers 1998 trends. Q1 1998 was strong.';
  assert.ok(freshnessScore(fresh, { nowYear: 2026 }) > freshnessScore(stale, { nowYear: 2026 }));
});

test('completenessScore: rises with abstract / methodology / conclusion anchors', () => {
  const full = 'Abstract: ...\nIntroduction\nMethodology\nResults\nConclusion\nReferences';
  assert.ok(completenessScore(full) >= 0.6);
});

test('gradeDocument: produces valid envelope', () => {
  const text = 'Acme Corp grew 32% YoY to $4.2M in 2026.';
  const g = gradeDocument(text);
  assert.ok(typeof g.letter === 'string');
  assert.ok(typeof g.score === 'number');
  assert.ok(typeof g.dimensions === 'object');
  for (const key of ['structure', 'density', 'citations', 'clarity', 'completeness', 'freshness', 'traceability']) {
    assert.ok(key in g.dimensions, `missing dimension: ${key}`);
  }
});

test('buildGradesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '# Abstract\nAcme Corp grew 32% to $4M in 2026. (Smith 2024) [1]' },
    { name: 'b.md', extractedText: '# Conclusion\nFoo bar baz.' },
  ];
  const batch = buildGradesForFiles(files);
  assert.equal(batch.perFile.length, 2);
  assert.ok(batch.aggregate);
  assert.ok(typeof batch.aggregate.averageScore === 'number');
});

test('renderGradeBlock returns markdown when files graded', () => {
  const files = [{ name: 'doc.md', extractedText: 'Abstract\nIntroduction\nMethodology\nResults\nConclusion' }];
  const batch = buildGradesForFiles(files);
  const md = renderGradeBlock(batch);
  assert.match(md, /^## DOCUMENT QUALITY GRADE/);
});

test('renderGradeBlock empty when no files', () => {
  assert.equal(renderGradeBlock({ perFile: [] }), '');
  assert.equal(renderGradeBlock(null), '');
});

test('grade improves with citations, structure and freshness', () => {
  const rich = `# Abstract
Acme Corp grew 32% YoY to $4.2M on 2026-06-15.
# Introduction
Background and prior work (Smith 2024) [1].
# Methodology
Sampled 1,000 transactions.
# Results
Revenue lifted by 32% (p < 0.05).
# Conclusion
The model is supported.
# References
[1] Smith, J. (2024). The market.`;
  const poor = 'Today the team had lunch.';
  const gRich = gradeDocument(rich, { nowYear: 2026 });
  const gPoor = gradeDocument(poor, { nowYear: 2026 });
  assert.ok(gRich.score > gPoor.score, `rich=${gRich.score} poor=${gPoor.score}`);
  assert.ok('ABCDF'.indexOf(gRich.letter) <= 'ABCDF'.indexOf(gPoor.letter));
});

test('handles non-string extractedText', () => {
  const batch = buildGradesForFiles([{ name: 'noisy', extractedText: null }, { name: 'good', extractedText: 'Abstract\nMethodology' }]);
  assert.equal(batch.perFile.length, 1);
});

test('aggregate.fileCount = number of graded files', () => {
  const files = [
    { name: 'a.md', extractedText: '# X\nHello.' },
    { name: 'b.md', extractedText: '# Y\nWorld.' },
  ];
  const batch = buildGradesForFiles(files);
  assert.equal(batch.aggregate.fileCount, 2);
});

test('dimensions are bounded [0,1]', () => {
  const g = gradeDocument('Mix of stuff with $1 USD on 2026-06-15 and (Pérez 2023) [1] citations.');
  for (const v of Object.values(g.dimensions)) {
    assert.ok(v >= 0 && v <= 1, `dimension out of [0,1]: ${v}`);
  }
});
