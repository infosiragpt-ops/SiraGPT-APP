'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-numeric-statistics');
const { extractStatistics, buildStatisticsForFiles, renderStatisticsBlock, _internal } = engine;
const { pickValue, pickUnit, pickDataset, splitSentences } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(extractStatistics('').total, 0);
  assert.equal(extractStatistics(null).total, 0);
});

test('pickValue: ignores stand-alone years', () => {
  assert.equal(pickValue('In 2026 the mean was 42 units.'), '42');
});

test('pickUnit: detects unit terms', () => {
  assert.equal(pickUnit('The mean was 42 seconds.'), 'seconds');
});

test('pickDataset: extracts dataset noun from "mean of X" form', () => {
  assert.match(pickDataset('The mean of response time was 120 ms.'), /response time/i);
});

test('splitSentences: handles English + Spanish punctuation', () => {
  const out = splitSentences('First sentence. Segunda oración! Tercera frase?');
  assert.ok(out.length >= 2);
});

test('extracts mean / median / std-dev', () => {
  const text = 'The mean response time was 120 ms. The median was 95 ms. The standard deviation was 15 ms.';
  const r = extractStatistics(text);
  const kinds = r.stats.map((s) => s.kind);
  assert.ok(kinds.includes('mean'));
  assert.ok(kinds.includes('median'));
  assert.ok(kinds.includes('std-dev'));
});

test('extracts percentile and confidence interval', () => {
  const text = 'The 95th percentile was 200 ms. The 95% confidence interval was 120 to 180.';
  const r = extractStatistics(text);
  const kinds = r.stats.map((s) => s.kind);
  assert.ok(kinds.includes('percentile'));
  assert.ok(kinds.includes('confidence-interval'));
});

test('extracts p-value and correlation', () => {
  const text = 'The p-value was p < 0.05. The correlation coefficient r = 0.72 was significant.';
  const r = extractStatistics(text);
  const kinds = r.stats.map((s) => s.kind);
  assert.ok(kinds.includes('p-value'));
  assert.ok(kinds.includes('correlation'));
});

test('extracts Spanish statistical language', () => {
  const text = 'El promedio de respuesta fue de 120 ms. La mediana fue 95 ms. La desviación estándar fue 15 ms.';
  const r = extractStatistics(text);
  const kinds = r.stats.map((s) => s.kind);
  assert.ok(kinds.includes('mean'));
  assert.ok(kinds.includes('median'));
});

test('extracts skewness / kurtosis when mentioned', () => {
  const text = 'The skewness was 0.6 and the kurtosis was 2.1 indicating a near-normal distribution.';
  const r = extractStatistics(text);
  const kinds = r.stats.map((s) => s.kind);
  assert.ok(kinds.includes('skewness'));
  assert.ok(kinds.includes('kurtosis'));
});

test('preserves source sentence intact', () => {
  const text = 'The mean response time was 120 ms across all endpoints.';
  const r = extractStatistics(text);
  assert.ok(r.stats[0].sentence.includes('mean response time'));
});

test('dedupes identical stats', () => {
  const text = 'The mean was 42. The mean was 42. The mean was 42.';
  const r = extractStatistics(text);
  assert.equal(r.stats.length, 1);
});

test('buildStatisticsForFiles aggregates and tags by file', () => {
  const files = [
    { name: 'a.md', extractedText: 'The mean was 12 ms. Median 9 ms.' },
    { name: 'b.md', extractedText: 'Standard deviation was 3.1 across endpoints.' },
  ];
  const batch = buildStatisticsForFiles(files);
  assert.ok(batch.perFile.length >= 1);
  if (batch.aggregate.length) {
    assert.ok(batch.aggregate.every((s) => s.file === 'a.md' || s.file === 'b.md'));
  }
});

test('renderStatisticsBlock returns markdown when stats exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'The mean was 12 ms. The median was 9 ms.' }];
  const batch = buildStatisticsForFiles(files);
  const md = renderStatisticsBlock(batch);
  assert.match(md, /^## NUMERIC STATISTICS/);
});

test('renderStatisticsBlock empty when no stats', () => {
  assert.equal(renderStatisticsBlock({ perFile: [] }), '');
  assert.equal(renderStatisticsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const batch = buildStatisticsForFiles([{ name: 'noisy', extractedText: null }, { name: 'good', extractedText: 'The mean is 42.' }]);
  assert.ok(Array.isArray(batch.perFile));
});
