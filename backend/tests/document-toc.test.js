'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-toc');
const { extractToc, buildTocForFiles, renderTocBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractToc('').total, 0);
  assert.equal(extractToc(null).total, 0);
});

test('detects "Table of Contents" section with items', () => {
  const text = `# Doc Title

## Table of Contents
- Introduction
- Background
- Methodology
- Results

## Introduction
...`;
  const r = extractToc(text);
  assert.equal(r.found, true);
  assert.ok(r.items.some((i) => /Introduction/.test(i.text)));
});

test('detects "Contents" header', () => {
  const text = `# Title\n\n## Contents\n1. Section A\n2. Section B`;
  const r = extractToc(text);
  assert.equal(r.found, true);
  assert.equal(r.items.length, 2);
});

test('detects Spanish "Índice"', () => {
  const text = `# Título\n\n## Índice\n- Introducción\n- Marco teórico`;
  const r = extractToc(text);
  assert.equal(r.found, true);
});

test('detects "Sumario"', () => {
  const text = `# Doc\n\n## Sumario\n- Item 1\n- Item 2`;
  const r = extractToc(text);
  assert.equal(r.found, true);
});

test('captures depth via indentation', () => {
  const text = `## TOC
- Top level
  - Nested 1
    - Deeper`;
  const r = extractToc(text);
  assert.equal(r.found, true);
  const depths = r.items.map((i) => i.depth);
  assert.ok(depths.includes(0));
  assert.ok(depths.some((d) => d > 0));
});

test('stops at next heading', () => {
  const text = `## TOC
- Item A
- Item B

## Next Section
prose here`;
  const r = extractToc(text);
  assert.equal(r.items.length, 2);
});

test('handles numbered list items', () => {
  const text = `## TOC
1. First
2. Second
3. Third`;
  const r = extractToc(text);
  assert.equal(r.items.length, 3);
});

test('caps items per TOC', () => {
  let text = '## TOC\n';
  for (let i = 0; i < 30; i++) text += `- Item ${i}\n`;
  const r = extractToc(text);
  assert.ok(r.items.length <= 24);
});

test('returns found:false when no TOC header', () => {
  const text = `Just some prose.\n\n- a bullet\n- another bullet`;
  const r = extractToc(text);
  assert.equal(r.found, false);
});

test('buildTocForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '## TOC\n- Item 1\n- Item 2' },
    { name: 'b.md', extractedText: '## Contents\n- A\n- B' },
  ];
  const r = buildTocForFiles(files);
  assert.equal(r.perFile.length, 2);
  assert.equal(r.totals.tocs, 2);
});

test('renderTocBlock returns markdown when found', () => {
  const files = [{ name: 'doc.md', extractedText: '## TOC\n- One\n- Two' }];
  const r = buildTocForFiles(files);
  const md = renderTocBlock(r);
  assert.match(md, /^## TABLE OF CONTENTS/);
});

test('renderTocBlock empty when nothing found', () => {
  assert.equal(renderTocBlock({ perFile: [] }), '');
  assert.equal(renderTocBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildTocForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '## TOC\n- a\n- b' },
  ]);
  assert.equal(r.perFile.length, 1);
});
