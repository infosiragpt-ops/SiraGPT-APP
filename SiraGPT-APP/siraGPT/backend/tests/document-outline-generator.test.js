'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-outline-generator');
const { extractOutline, buildOutlineForFiles, renderOutlineBlock } = engine;

test('extractOutline: empty input returns hasOutline=false', () => {
  const r = extractOutline('');
  assert.equal(r.hasOutline, false);
  assert.equal(r.totalSections, 0);
});

test('extractOutline: tolerates non-string input', () => {
  const r = extractOutline(null);
  assert.equal(r.hasOutline, false);
});

test('extractOutline: parses markdown # / ## / ### headings', () => {
  const text = `# Introduction
This is the introduction body paragraph with enough text.

## Background
Context goes here.

### Prior work
Earlier studies.

## Methodology
Detail goes here.

# Results
Findings.`;
  const r = extractOutline(text);
  assert.equal(r.hasOutline, true);
  assert.equal(r.totalSections, 5);
  assert.equal(r.depth, 3);
  assert.equal(r.source, 'markdown');
  assert.equal(r.sections[0].title, 'Introduction');
  assert.equal(r.sections[2].depth, 3);
});

test('extractOutline: parses setext (underline) headings', () => {
  const text = `Title One
=========

First paragraph after the title.

Subtitle A
----------

Body text here.

Subtitle B
----------

More body text.`;
  const r = extractOutline(text);
  assert.equal(r.hasOutline, true);
  assert.ok(r.sections.some((s) => s.title === 'Title One' && s.depth === 1));
  assert.ok(r.sections.some((s) => s.title === 'Subtitle A' && s.depth === 2));
});

test('extractOutline: parses numbered headings', () => {
  const text = `1. Introduction
This is the intro.

2. Methodology
Approach details.

2.1. Sampling
How we sampled.

2.2. Analysis
How we analysed.

3. Results
Findings.`;
  const r = extractOutline(text);
  assert.equal(r.hasOutline, true);
  assert.ok(r.sections.length >= 5);
  assert.ok(r.sections.some((s) => s.number === '2.1'));
  assert.ok(r.sections.some((s) => s.depth === 2));
});

test('extractOutline: falls back to ALL-CAPS banners when no other heading present', () => {
  const text = `RESUMEN EJECUTIVO

Este documento describe la estrategia para Q3.

INTRODUCCIÓN

Detalles del contexto.

CONCLUSIONES

Decisiones finales.`;
  const r = extractOutline(text);
  assert.equal(r.hasOutline, true);
  assert.equal(r.source, 'allcaps');
  assert.ok(r.sections.length >= 3);
});

test('extractOutline: includes excerpt for each section', () => {
  const text = `# Section A
The first interesting paragraph that should be excerpted here, with enough words to verify clipping behaviour later if needed.

# Section B
Another paragraph for the second section.`;
  const r = extractOutline(text);
  assert.ok(r.sections[0].excerpt.length > 0);
  assert.match(r.sections[0].excerpt, /first interesting paragraph/);
});

test('extractOutline: caps depth at MAX_DEPTH', () => {
  const text = `# H1
## H2
### H3
#### H4
##### H5
###### H6
####### H7-should-still-be-h6 (markdown)`;
  const r = extractOutline(text);
  for (const s of r.sections) {
    assert.ok(s.depth <= 6);
  }
});

test('extractOutline: includes section word count and reading time', () => {
  const text = `# Section A
${'word '.repeat(220)}

# Section B
${'word '.repeat(100)}`;
  const r = extractOutline(text);
  assert.ok(r.sections[0].words >= 100);
  assert.ok(r.estimatedReadingMinutes >= 1);
});

test('extractOutline: slugifies section titles for stable references', () => {
  const text = `# Análisis del Mercado y Competencia
Body.`;
  const r = extractOutline(text);
  assert.match(r.sections[0].slug, /analisis|mercado/);
});

test('buildOutlineForFiles: chooses primary file by section count', () => {
  const files = [
    { originalName: 'small.md', extractedText: '# Only one section\nBody.' },
    { originalName: 'big.md', extractedText: '# A\nbody\n\n# B\nbody\n\n# C\nbody\n\n# D\nbody' },
  ];
  const r = buildOutlineForFiles(files);
  assert.equal(r.primary.file, 'big.md');
});

test('buildOutlineForFiles: returns null primary when no headings detected', () => {
  const files = [{ originalName: 'plain.txt', extractedText: 'Just a plain paragraph with no structure at all.' }];
  const r = buildOutlineForFiles(files);
  assert.equal(r.primary, null);
});

test('renderOutlineBlock: returns empty when no outline', () => {
  assert.equal(renderOutlineBlock(null), '');
  assert.equal(renderOutlineBlock({ hasOutline: false, totalSections: 0, sections: [] }), '');
});

test('renderOutlineBlock: emits indented hierarchical list', () => {
  const text = `# Top
body
## Sub A
body
## Sub B
body`;
  const r = extractOutline(text);
  const block = renderOutlineBlock(r);
  assert.match(block, /## DOCUMENT OUTLINE/);
  assert.match(block, /Top/);
  assert.match(block, /Sub A/);
  // Indentation should differ for depth 2
  assert.match(block, /\n {2}- .*Sub A/);
});
