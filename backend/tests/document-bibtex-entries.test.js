'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-bibtex-entries');
const { extractBibtexEntries, buildBibtexEntriesForFiles, renderBibtexEntriesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractBibtexEntries('').total, 0);
  assert.equal(extractBibtexEntries(null).total, 0);
});

test('detects @article entry', () => {
  const r = extractBibtexEntries('@article{smith2023,title={X}}');
  assert.ok(r.entries.some((e) => e.type === 'article' && e.category === 'journal'));
});

test('detects @book entry', () => {
  const r = extractBibtexEntries('@book{jones2020, title={Hello}}');
  assert.ok(r.entries.some((e) => e.type === 'book' && e.category === 'book'));
});

test('detects @inproceedings', () => {
  const r = extractBibtexEntries('@inproceedings{conf2024,title={X}}');
  assert.ok(r.entries.some((e) => e.category === 'conference'));
});

test('detects @phdthesis', () => {
  const r = extractBibtexEntries('@phdthesis{dissertation,title={X}}');
  assert.ok(r.entries.some((e) => e.category === 'thesis'));
});

test('detects @misc', () => {
  const r = extractBibtexEntries('@misc{web2024, title={X}, url={y}}');
  assert.ok(r.entries.some((e) => e.category === 'misc'));
});

test('detects BibLaTeX @online', () => {
  const r = extractBibtexEntries('@online{w23,title={X}}');
  assert.ok(r.entries.some((e) => e.category === 'online'));
});

test('detects @software', () => {
  const r = extractBibtexEntries('@software{tool2024,title={X}}');
  assert.ok(r.entries.some((e) => e.category === 'software'));
});

test('captures cite key', () => {
  const r = extractBibtexEntries('@article{smith2023,title={X}}');
  assert.equal(r.entries[0].key, 'smith2023');
});

test('dedupes identical entries', () => {
  const r = extractBibtexEntries('@article{x,a=1} @article{x,b=2}');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `@article{key${i}, title={x}}\n`;
  const r = extractBibtexEntries(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by category', () => {
  const r = extractBibtexEntries(
    '@article{a,t={x}} @book{b,t={y}} @inproceedings{c,t={z}}'
  );
  assert.ok(r.totals.journal >= 1);
  assert.ok(r.totals.book >= 1);
  assert.ok(r.totals.conference >= 1);
});

test('buildBibtexEntriesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.bib', extractedText: '@article{a,t={x}}' },
    { name: 'b.bib', extractedText: '@book{b,t={y}}' },
  ];
  const r = buildBibtexEntriesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBibtexEntriesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'refs.bib', extractedText: '@article{a,t={x}}' }];
  const r = buildBibtexEntriesForFiles(files);
  const md = renderBibtexEntriesBlock(r);
  assert.match(md, /^## BIBTEX/);
});

test('renderBibtexEntriesBlock empty when nothing surfaces', () => {
  assert.equal(renderBibtexEntriesBlock({ perFile: [] }), '');
  assert.equal(renderBibtexEntriesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBibtexEntriesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '@article{a,t={x}}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
