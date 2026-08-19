'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-footnotes');
const { extractFootnotes, buildFootnotesForFiles, renderFootnotesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractFootnotes('').total, 0);
  assert.equal(extractFootnotes(null).total, 0);
});

test('extracts markdown footnote definitions', () => {
  const text = `Body with reference[^1] and another[^note].

[^1]: This is the first note.
[^note]: This is the named note.`;
  const r = extractFootnotes(text);
  assert.equal(r.footnotes.length, 2);
  assert.ok(r.footnotes.some((f) => f.marker === '1'));
  assert.ok(r.footnotes.some((f) => f.marker === 'note'));
});

test('extracts numbered notes from References section', () => {
  const text = `Body of the document.

References
1. Smith, J. (2024). The Study.
2. Pérez, A. (2025). El estudio relacionado.`;
  const r = extractFootnotes(text);
  assert.ok(r.footnotes.some((f) => f.kind === 'numbered' && f.marker === '1'));
});

test('does not extract numbered lists outside a References section', () => {
  const text = `Body with a regular list:
1. First item.
2. Second item.
No references section.`;
  const r = extractFootnotes(text);
  const numbered = r.footnotes.filter((f) => f.kind === 'numbered');
  assert.equal(numbered.length, 0);
});

test('detects inline markdown markers', () => {
  const text = 'Some text[^1] and more[^2].';
  const r = extractFootnotes(text);
  assert.ok(r.inlineMarkers.includes('1'));
  assert.ok(r.inlineMarkers.includes('2'));
});

test('detects superscript markers', () => {
  const text = 'Some text¹ and another².';
  const r = extractFootnotes(text);
  assert.ok(r.inlineMarkers.length >= 1);
});

test('dedupes identical footnote definitions', () => {
  const text = `[^1]: First note.
[^1]: First note again.`;
  const r = extractFootnotes(text);
  assert.equal(r.footnotes.filter((f) => f.marker === '1').length, 1);
});

test('caps footnotes per file', () => {
  let text = '';
  for (let i = 1; i <= 25; i++) text += `[^${i}]: Note ${i} body text.\n`;
  const r = extractFootnotes(text);
  assert.ok(r.footnotes.length <= 14);
});

test('buildFootnotesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Text[^1]\n[^1]: A note.' },
    { name: 'b.md', extractedText: 'Text[^x]\n[^x]: Another note.' },
  ];
  const r = buildFootnotesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderFootnotesBlock returns markdown when footnotes exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Text[^1].\n[^1]: The note body.' }];
  const r = buildFootnotesForFiles(files);
  const md = renderFootnotesBlock(r);
  assert.match(md, /^## FOOTNOTES/);
});

test('renderFootnotesBlock empty when nothing surfaces', () => {
  assert.equal(renderFootnotesBlock({ perFile: [] }), '');
  assert.equal(renderFootnotesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildFootnotesForFiles([{ name: 'a', extractedText: null }, { name: 'b', extractedText: '[^1]: note.' }]);
  assert.ok(Array.isArray(r.perFile));
});
