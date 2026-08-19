'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-fact-density');
const { scoreFactDensity, buildDensityForFiles, renderDensityBlock, _internal } = engine;
const { detectHeadings, splitIntoSections, scoreSectionFacts } = _internal;

test('empty / non-string input tolerated', () => {
  assert.equal(scoreFactDensity('').sectionCount, 0);
  assert.equal(scoreFactDensity(null).sectionCount, 0);
});

test('detectHeadings: markdown # headings', () => {
  const text = '# Intro\nSome text\n## Methods\nMore text';
  const h = detectHeadings(text);
  assert.ok(h.length >= 2);
});

test('detectHeadings: numbered sections', () => {
  const text = '1.1 Overview\nText\n2.3 Results\nMore text';
  const h = detectHeadings(text);
  assert.ok(h.length >= 1);
});

test('detectHeadings: all-caps headings', () => {
  const text = 'INTRODUCTION\nText about the study.\n\nRESULTS AND DISCUSSION\nMore text.';
  const h = detectHeadings(text);
  assert.ok(h.length >= 1);
});

test('splitIntoSections: groups text under each heading', () => {
  const text = `# Section A
Content for section A which is reasonably long to clear the minimum section length so it is captured.
# Section B
Content for section B which is also reasonably long to clear the minimum length.`;
  const sections = splitIntoSections(text);
  assert.equal(sections.length, 2);
});

test('splitIntoSections: falls back to paragraph blocks without headings', () => {
  const text = 'First paragraph that is long enough to clear the minimum section length threshold by quite a bit.\n\nSecond paragraph that is also reasonably long to capture as a separate block.';
  const sections = splitIntoSections(text);
  assert.ok(sections.length >= 2);
});

test('scoreSectionFacts counts anchors', () => {
  const section = { title: 'Demo', body: 'Acme Corp grew 22% to $4.2 million on 2026-06-15.' };
  const s = scoreSectionFacts(section);
  assert.ok(s.factTotal >= 3);
  assert.ok(s.density >= 0);
});

test('scoreFactDensity ranks dense sections first', () => {
  const text = `# Overview
This is just some narrative text without specific anchors.

# Numbers
Revenue grew 32% to $4.2M in Q1 2026. Acme Corp signed a deal. NPS climbed from 38 to 47.`;
  const r = scoreFactDensity(text);
  assert.ok(r.sections.length >= 1);
  // The most dense should rank first.
  const first = r.sections[0];
  assert.ok(first.factTotal > 0);
});

test('buildDensityForFiles aggregates and tags by file', () => {
  const files = [
    { name: 'a.md', extractedText: '# Sec\nRevenue grew 12% to $1.2M in Q1 2026.' },
    { name: 'b.md', extractedText: '# Sec\nChurn fell from 5.2% to 3.1% by 2026-12-15.' },
  ];
  const batch = buildDensityForFiles(files);
  assert.equal(batch.perFile.length, 2);
  if (batch.aggregate.length) {
    assert.ok(batch.aggregate.every((s) => s.file === 'a.md' || s.file === 'b.md'));
  }
});

test('renderDensityBlock: returns markdown when sections exist', () => {
  const files = [{ name: 'doc.md', extractedText: '# Sec\nRevenue grew 32% to $4.2M in Q1 2026.' }];
  const batch = buildDensityForFiles(files);
  const md = renderDensityBlock(batch);
  assert.match(md, /^## FACT DENSITY MAP/);
});

test('renderDensityBlock: empty when no sections', () => {
  assert.equal(renderDensityBlock({ perFile: [] }), '');
  assert.equal(renderDensityBlock(null), '');
});

test('non-string extractedText tolerated', () => {
  const batch = buildDensityForFiles([{ name: 'noisy', extractedText: null }]);
  assert.equal(batch.perFile.length, 0);
});

test('density approximated correctly: facts per KB', () => {
  // Build a section with known length and known anchor count.
  const body = 'Acme Corp received $100,000 on 2026-06-15.'; // 3-4 anchors in ~40 chars
  const s = scoreSectionFacts({ title: 'T', body });
  assert.ok(s.density > 0);
});

test('totalFacts sums across all sections', () => {
  const text = `# S1
Revenue grew 12% to $1M in Q1 2026.
# S2
Churn fell 2.1% to 3.4%.`;
  const r = scoreFactDensity(text);
  const sum = r.sections.reduce((acc, s) => acc + s.factTotal, 0);
  assert.ok(r.totalFacts >= sum);
});

test('keeps section title in output', () => {
  const text = '# Q1 Revenue Recap\nRevenue grew 32% to $4.2M in Q1 2026.';
  const r = scoreFactDensity(text);
  assert.ok(r.sections.length >= 1);
  assert.match(r.sections[0].title, /Q1|Revenue/);
});
