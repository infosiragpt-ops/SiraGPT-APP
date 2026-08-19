'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-percentages');
const { extractPercentages, buildPercentagesForFiles, renderPercentagesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPercentages('').total, 0);
  assert.equal(extractPercentages(null).total, 0);
});

test('detects numeric percentage 12%', () => {
  const r = extractPercentages('Conversion is 12% this quarter.');
  assert.ok(r.entries.some((e) => e.kind === 'percent' && e.value === '12%'));
});

test('detects +15.5% with sign and decimal', () => {
  const r = extractPercentages('Growth was +15.5% YoY.');
  assert.ok(r.entries.some((e) => /15\.5/.test(e.value)));
});

test('detects negative percentage', () => {
  const r = extractPercentages('Drop of -3% in adoption.');
  assert.ok(r.entries.some((e) => /-3/.test(e.value)));
});

test('detects word form "12 percent"', () => {
  const r = extractPercentages('We hit 12 percent margin.');
  assert.ok(r.entries.some((e) => e.kind === 'percent' && /12/.test(e.value)));
});

test('detects Spanish "12 por ciento"', () => {
  const r = extractPercentages('Crecimiento del 12 por ciento este año.');
  assert.ok(r.entries.some((e) => e.kind === 'percent'));
});

test('detects percentage points "15pp"', () => {
  const r = extractPercentages('Up 15pp from last year.');
  assert.ok(r.entries.some((e) => e.kind === 'pp'));
});

test('detects basis points "25bps"', () => {
  const r = extractPercentages('Rate cut by 25bps.');
  assert.ok(r.entries.some((e) => e.kind === 'bps'));
});

test('detects "percentage points" full form', () => {
  const r = extractPercentages('Increased by 10 percentage points.');
  assert.ok(r.entries.some((e) => e.kind === 'pp'));
});

test('detects "basis points" full form', () => {
  const r = extractPercentages('Cut by 100 basis points.');
  assert.ok(r.entries.some((e) => e.kind === 'bps'));
});

test('rejects integers that are part of words', () => {
  const r = extractPercentages('Tag X3%foo');
  // X is letter so lookbehind blocks
  assert.equal(r.entries.filter((e) => e.value === '3%').length, 0);
});

test('dedupes identical entries with same context', () => {
  const r = extractPercentages('12% noted. 12% noted.');
  assert.ok(r.entries.length <= 2);
});

test('counts totals by kind', () => {
  const r = extractPercentages('Up 12%, then +15pp, then 25bps.');
  assert.ok(r.totals.percent >= 1);
  assert.ok(r.totals.pp >= 1);
  assert.ok(r.totals.bps >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 40; i++) text += `Increased ${i}% growth `;
  const r = extractPercentages(text);
  assert.ok(r.entries.length <= 24);
});

test('buildPercentagesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Up 12%' },
    { name: 'b.md', extractedText: 'Drop 3%' },
  ];
  const r = buildPercentagesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPercentagesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Up 12% YoY' }];
  const r = buildPercentagesForFiles(files);
  const md = renderPercentagesBlock(r);
  assert.match(md, /^## PERCENTAGES & RATES/);
});

test('renderPercentagesBlock empty when nothing surfaces', () => {
  assert.equal(renderPercentagesBlock({ perFile: [] }), '');
  assert.equal(renderPercentagesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPercentagesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '12%' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('captures surrounding context', () => {
  const r = extractPercentages('Q3 conversion ratio: 12% across all segments.');
  assert.ok(r.entries[0].context.includes('conversion'));
});
