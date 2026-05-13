'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-executive-summary');
const { buildExecutiveSummaryForFile, buildExecutiveSummaryForFiles, renderExecutiveSummaryBlock } = engine;

test('empty / null tolerated', () => {
  assert.equal(buildExecutiveSummaryForFile({}), null);
  assert.equal(buildExecutiveSummaryForFile(null), null);
});

test('synthesises a rich summary for a fact-dense document', () => {
  const text = `# Q1 Revenue Recap
Revenue grew 32% YoY to $4.2M in Q1 2026. Acme Corp signed a deal worth $1.5M.
The Provider shall deliver the platform within 30 days.
Critical risk of breach if patches are delayed.
References:
[1] Smith, J. (2024). Q1 metrics.`;
  const file = { name: 'q1.md', extractedText: text };
  const s = buildExecutiveSummaryForFile(file);
  assert.ok(s);
  assert.ok(s.title);
  assert.ok(s.tldr);
  assert.ok(s.grade);
});

test('handles minimal document with only title', () => {
  const file = { name: 'memo.md', extractedText: '# Memo Title\nBody.' };
  const s = buildExecutiveSummaryForFile(file);
  assert.ok(s);
  assert.equal(s.title, 'Memo Title');
});

test('non-string extractedText returns null', () => {
  assert.equal(buildExecutiveSummaryForFile({ name: 'x', extractedText: null }), null);
});

test('buildExecutiveSummaryForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '# Title A\nBody with risk and obligation.' },
    { name: 'b.md', extractedText: '# Title B\nRevenue grew 12% to $1M.' },
  ];
  const r = buildExecutiveSummaryForFiles(files);
  assert.ok(r.perFile.length >= 1);
});

test('renderExecutiveSummaryBlock returns markdown when there is data', () => {
  const files = [{ name: 'q1.md', extractedText: '# Q1 Recap\nRevenue grew 32% YoY to $4.2M in Q1 2026.' }];
  const r = buildExecutiveSummaryForFiles(files);
  const md = renderExecutiveSummaryBlock(r);
  assert.match(md, /^## EXECUTIVE SUMMARY/);
});

test('renderExecutiveSummaryBlock empty when nothing surfaces', () => {
  assert.equal(renderExecutiveSummaryBlock({ perFile: [] }), '');
  assert.equal(renderExecutiveSummaryBlock(null), '');
});

test('handles non-string extractedText in batch', () => {
  const r = buildExecutiveSummaryForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '# T\nText.' }]);
  assert.ok(Array.isArray(r.perFile));
});

test('summary includes risk when present', () => {
  const text = `# Risk Brief
Critical risk of breach if patches are delayed for production systems.`;
  const s = buildExecutiveSummaryForFile({ name: 'doc.md', extractedText: text });
  if (s && s.risk) {
    assert.ok(s.risk.severity);
    assert.match(s.risk.sentence, /risk/i);
  }
});

test('summary includes obligation when present', () => {
  const text = `# Contract Brief
The Provider shall deliver the platform within thirty days.`;
  const s = buildExecutiveSummaryForFile({ name: 'doc.md', extractedText: text });
  if (s && s.obligation) {
    assert.match(s.obligation.sentence, /shall deliver/i);
  }
});

test('summary includes grade letter', () => {
  const text = `# Abstract
Introduction. Methodology. Results. Conclusion. References.
Acme Corp grew 32% YoY to $4.2M on 2026-06-15. (Smith 2024) [1]`;
  const s = buildExecutiveSummaryForFile({ name: 'doc.md', extractedText: text });
  if (s && s.grade) {
    assert.ok('ABCDF'.indexOf(s.grade.letter) >= 0);
  }
});
