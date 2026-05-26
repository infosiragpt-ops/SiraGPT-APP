'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-benchmarks');
const { extractBenchmarks, buildBenchmarksForFiles, renderBenchmarksBlock, _internal } = engine;
const { isBenchmark } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractBenchmarks('').total, 0);
  assert.equal(extractBenchmarks(null).total, 0);
});

test('isBenchmark: English forms', () => {
  assert.ok(isBenchmark('Our growth was 32% vs the industry average of 18%.'));
  assert.ok(isBenchmark('Compared to last year, costs declined.'));
  assert.ok(isBenchmark('Our retention exceeds the peer group average.'));
});

test('isBenchmark: Spanish forms', () => {
  assert.ok(isBenchmark('Frente al promedio del sector, crecimos un 32%.'));
  assert.ok(isBenchmark('Comparado con el año pasado, los costos bajaron.'));
  assert.ok(isBenchmark('Respecto al grupo de pares, mejoramos.'));
});

test('isBenchmark: non-benchmark rejected', () => {
  assert.ok(!isBenchmark('The team had lunch on Tuesday.'));
});

test('extractBenchmarks returns benchmark sentences', () => {
  const text = 'Our growth was 32% vs the industry average of 18%. Compared to peers, retention is stronger.';
  const r = extractBenchmarks(text);
  assert.equal(r.total, 2);
});

test('dedupes identical sentences', () => {
  const text = 'Our growth vs the industry average is 14%. Our growth vs the industry average is 14%.';
  const r = extractBenchmarks(text);
  assert.equal(r.total, 1);
});

test('buildBenchmarksForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Growth 32% vs industry average 18%.' },
    { name: 'b.md', extractedText: 'Comparado con la línea base, mejoramos.' },
  ];
  const r = buildBenchmarksForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBenchmarksBlock returns markdown when items exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Growth 32% vs industry average 18%.' }];
  const r = buildBenchmarksForFiles(files);
  const md = renderBenchmarksBlock(r);
  assert.match(md, /^## BENCHMARK REFERENCES/);
});

test('renderBenchmarksBlock empty when nothing surfaces', () => {
  assert.equal(renderBenchmarksBlock({ perFile: [] }), '');
  assert.equal(renderBenchmarksBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBenchmarksForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: 'Growth vs the industry average.' }]);
  assert.ok(Array.isArray(r.perFile));
});
