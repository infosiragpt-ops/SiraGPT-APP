'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-fiscal-year');
const { extractFiscalYear, buildFiscalYearForFiles, renderFiscalYearBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractFiscalYear('').total, 0);
  assert.equal(extractFiscalYear(null).total, 0);
});

test('detects FY24', () => {
  const r = extractFiscalYear('Revenue in FY24 grew 15%.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-short'));
});

test('detects FY2024', () => {
  const r = extractFiscalYear('Revenue in FY2024 grew 15%.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-short'));
});

test('detects "fiscal year 2024"', () => {
  const r = extractFiscalYear('Performance in fiscal year 2024 exceeded.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-full'));
});

test('detects "fiscal 2024"', () => {
  const r = extractFiscalYear('In fiscal 2024 we shipped many features.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-full'));
});

test('detects Q1', () => {
  const r = extractFiscalYear('Q1 results released today.');
  assert.ok(r.entries.some((e) => e.kind === 'quarter'));
});

test('detects Q3 2024', () => {
  const r = extractFiscalYear('Q3 2024 earnings call scheduled.');
  assert.ok(r.entries.some((e) => e.kind === 'quarter'));
});

test('detects Spanish "año fiscal 2024"', () => {
  const r = extractFiscalYear('En el año fiscal 2024 logramos crecimiento.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-es'));
});

test('detects "ejercicio fiscal"', () => {
  const r = extractFiscalYear('Cierre del ejercicio fiscal 2023.');
  assert.ok(r.entries.some((e) => e.kind === 'fy-es'));
});

test('detects T1 Spanish quarter', () => {
  const r = extractFiscalYear('Resultados del T1 publicados.');
  assert.ok(r.entries.some((e) => e.kind === 'quarter-es'));
});

test('dedupes identical entries', () => {
  const r = extractFiscalYear('FY24 vs FY24 comparison.');
  assert.equal(r.entries.filter((e) => e.phrase === 'FY24').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `FY${i % 99} `;
  const r = extractFiscalYear(text);
  assert.ok(r.entries.length <= 20);
});

test('buildFiscalYearForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'FY24 results' },
    { name: 'b.md', extractedText: 'Q1 update' },
  ];
  const r = buildFiscalYearForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFiscalYearBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'FY24 results' }];
  const r = buildFiscalYearForFiles(files);
  const md = renderFiscalYearBlock(r);
  assert.match(md, /^## FISCAL YEAR/);
});

test('renderFiscalYearBlock empty when nothing surfaces', () => {
  assert.equal(renderFiscalYearBlock({ perFile: [] }), '');
  assert.equal(renderFiscalYearBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFiscalYearForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'FY24' },
  ]);
  assert.equal(r.perFile.length, 1);
});
