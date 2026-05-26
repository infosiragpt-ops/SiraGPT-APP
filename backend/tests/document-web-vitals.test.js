'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-web-vitals');
const { extractWebVitals, buildWebVitalsForFiles, renderWebVitalsBlock, _internal } = engine;
const { classify } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractWebVitals('').total, 0);
  assert.equal(extractWebVitals(null).total, 0);
});

test('classify LCP buckets', () => {
  assert.equal(classify('LCP', 2000, 'ms'), 'good');
  assert.equal(classify('LCP', 3000, 'ms'), 'needs-improvement');
  assert.equal(classify('LCP', 5000, 'ms'), 'poor');
});

test('classify CLS unitless', () => {
  assert.equal(classify('CLS', 0.05, ''), 'good');
  assert.equal(classify('CLS', 0.15, ''), 'needs-improvement');
  assert.equal(classify('CLS', 0.4, ''), 'poor');
});

test('classify TTFB in seconds', () => {
  assert.equal(classify('TTFB', 0.5, 's'), 'good'); // 500ms
  assert.equal(classify('TTFB', 1.0, 's'), 'needs-improvement');
});

test('detects LCP with value', () => {
  const r = extractWebVitals('Target LCP: 2200ms for hero render.');
  assert.ok(r.entries.some((e) => e.metric === 'LCP' && e.value === 2200));
});

test('detects FID with value', () => {
  const r = extractWebVitals('Achieved FID = 80ms');
  assert.ok(r.entries.some((e) => e.metric === 'FID' && e.bucket === 'good'));
});

test('detects INP with value', () => {
  const r = extractWebVitals('INP: 250ms — needs work');
  assert.ok(r.entries.some((e) => e.metric === 'INP'));
});

test('detects CLS unitless', () => {
  const r = extractWebVitals('CLS = 0.12 on mobile');
  assert.ok(r.entries.some((e) => e.metric === 'CLS' && e.value === 0.12));
});

test('detects TTFB', () => {
  const r = extractWebVitals('TTFB: 600ms');
  assert.ok(r.entries.some((e) => e.metric === 'TTFB' && e.bucket === 'good'));
});

test('classifies poor LCP correctly', () => {
  const r = extractWebVitals('LCP: 5000ms (terrible)');
  assert.ok(r.entries.some((e) => e.metric === 'LCP' && e.bucket === 'poor'));
});

test('detects bare mention without value', () => {
  const r = extractWebVitals('Investigate LCP regression next sprint');
  assert.ok(r.entries.some((e) => e.metric === 'LCP' && e.source === 'mention'));
});

test('dedupes identical metric+value pairs', () => {
  const r = extractWebVitals('LCP: 2200ms here and LCP: 2200ms again');
  assert.equal(r.entries.filter((e) => e.metric === 'LCP' && e.value === 2200).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `LCP: ${1000 + i}ms `;
  const r = extractWebVitals(text);
  assert.ok(r.entries.length <= 14);
});

test('buildWebVitalsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'LCP: 2000ms' },
    { name: 'b.md', extractedText: 'CLS: 0.1' },
  ];
  const r = buildWebVitalsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderWebVitalsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'perf', extractedText: 'LCP: 2200ms' }];
  const r = buildWebVitalsForFiles(files);
  const md = renderWebVitalsBlock(r);
  assert.match(md, /^## WEB VITALS/);
});

test('renderWebVitalsBlock empty when nothing surfaces', () => {
  assert.equal(renderWebVitalsBlock({ perFile: [] }), '');
  assert.equal(renderWebVitalsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildWebVitalsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'LCP: 2200ms' },
  ]);
  assert.equal(r.perFile.length, 1);
});
