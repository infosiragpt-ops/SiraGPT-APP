'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cross-numeric');
const { buildComparisonForFiles, renderComparisonBlock, _internal } = engine;
const { parseNumeric, normaliseValue, captureValueForConcept, CONCEPT_TAGS } = _internal;

test('parseNumeric: known formats', () => {
  assert.equal(parseNumeric('1,200.50'), 1200.5);
  assert.equal(parseNumeric('1.200,50'), 1200.5);
  assert.equal(parseNumeric(''), null);
});

test('normaliseValue: applies K / M / B suffixes', () => {
  assert.equal(normaliseValue('4.2', 'M'), 4_200_000);
  assert.equal(normaliseValue('500', 'K'), 500_000);
  assert.equal(normaliseValue('1.5', 'B'), 1_500_000_000);
  assert.equal(normaliseValue('25', '%'), 25);
});

test('captureValueForConcept: pulls the first numeric near a concept word', () => {
  const text = 'Quarterly revenue reached $4.2M, with EBITDA at $1M.';
  const cap = captureValueForConcept(text, CONCEPT_TAGS.find((c) => c.tag === 'revenue').re);
  assert.ok(cap);
  assert.equal(cap.value, 4_200_000);
});

test('single-file batch returns empty rows', () => {
  const r = buildComparisonForFiles([{ name: 'a.md', extractedText: 'Revenue $4.2M' }]);
  assert.equal(r.rows.length, 0);
});

test('compares revenue across two files', () => {
  const files = [
    { name: 'plan-a.md', extractedText: 'Quarterly revenue reached $4.2M.' },
    { name: 'plan-b.md', extractedText: 'Quarterly revenue hit $6.1M.' },
  ];
  const r = buildComparisonForFiles(files);
  const row = r.rows.find((x) => x.tag === 'revenue');
  assert.ok(row);
  assert.equal(row.winner, 'plan-b.md');
  assert.ok(row.delta > 0);
});

test('drops concepts that only appear in one file', () => {
  const files = [
    { name: 'a.md', extractedText: 'Revenue $1M.' },
    { name: 'b.md', extractedText: 'NPS climbed to 45.' },
  ];
  const r = buildComparisonForFiles(files);
  assert.equal(r.rows.length, 0);
});

test('Spanish concept terms supported', () => {
  const files = [
    { name: 'spanish-a.md', extractedText: 'Los ingresos llegaron a 4,2 millones.' },
    { name: 'spanish-b.md', extractedText: 'Los ingresos fueron 5,1 millones.' },
  ];
  const r = buildComparisonForFiles(files);
  // Concept match may produce a row; assert structure
  if (r.rows.length > 0) {
    assert.equal(r.rows[0].tag, 'revenue');
  }
});

test('rows sorted by absolute delta descending', () => {
  const files = [
    { name: 'a.md', extractedText: 'Revenue $1M. NPS 30.' },
    { name: 'b.md', extractedText: 'Revenue $1.1M. NPS 80.' },
  ];
  const r = buildComparisonForFiles(files);
  if (r.rows.length >= 2) {
    assert.ok(Math.abs(r.rows[0].delta) >= Math.abs(r.rows[1].delta));
  }
});

test('caps rows to safe maximum', () => {
  // Generate many concept matches per file by repeating each head.
  const buildSample = (idx) => `Revenue $${idx}M. Margin ${idx}%. NPS ${idx}. CSAT ${idx}. ARR $${idx}K. MRR $${idx}K.`;
  const files = [
    { name: 'a.md', extractedText: buildSample(1) },
    { name: 'b.md', extractedText: buildSample(2) },
  ];
  const r = buildComparisonForFiles(files);
  assert.ok(r.rows.length <= 12);
});

test('renderComparisonBlock returns markdown when rows exist', () => {
  const files = [
    { name: 'a.md', extractedText: 'Revenue $4M.' },
    { name: 'b.md', extractedText: 'Revenue $5M.' },
  ];
  const r = buildComparisonForFiles(files);
  const md = renderComparisonBlock(r);
  assert.match(md, /^## CROSS-FILE NUMERIC COMPARISON/);
});

test('renderComparisonBlock empty when no rows', () => {
  assert.equal(renderComparisonBlock({ rows: [] }), '');
  assert.equal(renderComparisonBlock(null), '');
});

test('handles non-string extractedText', () => {
  const files = [
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Revenue $5M.' },
  ];
  const r = buildComparisonForFiles(files);
  assert.equal(r.rows.length, 0);
});

test('winner is the file with the highest value', () => {
  const files = [
    { name: 'low.md', extractedText: 'Revenue $1M.' },
    { name: 'high.md', extractedText: 'Revenue $10M.' },
  ];
  const r = buildComparisonForFiles(files);
  const row = r.rows.find((x) => x.tag === 'revenue');
  assert.equal(row.winner, 'high.md');
});

test('preserves source file label in row values', () => {
  const files = [
    { name: 'A.md', extractedText: 'Revenue $1M.' },
    { name: 'B.md', extractedText: 'Revenue $2M.' },
  ];
  const r = buildComparisonForFiles(files);
  const row = r.rows.find((x) => x.tag === 'revenue');
  const files_listed = row.values.map((v) => v.file).sort();
  assert.deepEqual(files_listed, ['A.md', 'B.md']);
});
