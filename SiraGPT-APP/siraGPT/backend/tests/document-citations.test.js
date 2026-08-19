'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-citations');
const { extractCitations, buildCitationsForFiles, renderCitationsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCitations('').total, 0);
  assert.equal(extractCitations(null).total, 0);
});

test('detects numeric citation [1]', () => {
  const r = extractCitations('Recent work [1] showed the result.');
  assert.ok(r.citations.some((c) => c.kind === 'numeric' && c.value === '[1]'));
});

test('detects numeric range [3,4,5]', () => {
  const r = extractCitations('Several works [3,4,5] agree.');
  assert.ok(r.citations.some((c) => c.kind === 'numeric'));
});

test('detects bracketed author-year [Smith2020]', () => {
  const r = extractCitations('Per [Smith2020], the gradient is unstable.');
  assert.ok(r.citations.some((c) => c.kind === 'bracketAuthor'));
});

test('detects parenthetical (Smith, 2020)', () => {
  const r = extractCitations('Per (Smith, 2020), this holds.');
  assert.ok(r.citations.some((c) => c.kind === 'parenAuthor'));
});

test('detects (Smith et al., 2020)', () => {
  const r = extractCitations('See (Smith et al., 2020) for details.');
  assert.ok(r.citations.some((c) => c.kind === 'parenAuthor'));
});

test('detects "Smith et al." in-text', () => {
  const r = extractCitations('Smith et al. (2020) showed empirical evidence.');
  assert.ok(r.citations.some((c) => c.kind === 'etalInline'));
});

test('detects References section header', () => {
  const text = `Main body.\n\n## References\n- ...\n`;
  const r = extractCitations(text);
  assert.equal(r.hasReferencesSection, true);
});

test('detects Spanish "Referencias" section', () => {
  const text = `Texto principal.\n\n## Referencias\n- ...\n`;
  const r = extractCitations(text);
  assert.equal(r.hasReferencesSection, true);
});

test('detects Bibliografía', () => {
  const text = `Documento.\n\n## Bibliografía\n- ...\n`;
  const r = extractCitations(text);
  assert.equal(r.hasReferencesSection, true);
});

test('dedupes identical citations', () => {
  const r = extractCitations('See [1] and [1] again.');
  assert.equal(r.citations.filter((c) => c.kind === 'numeric' && c.value === '[1]').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 1; i <= 20; i++) text += `Found in [${i}]. `;
  const r = extractCitations(text);
  assert.ok(r.totals.numeric <= 12);
});

test('counts totals by kind', () => {
  const r = extractCitations('See [1], also (Smith, 2020), and Jones et al. (2019)');
  assert.ok(r.totals.numeric >= 1);
  assert.ok(r.totals.parenAuthor >= 1);
  assert.ok(r.totals.etalInline >= 1);
});

test('buildCitationsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Cite [1]' },
    { name: 'b.md', extractedText: '(Smith, 2020)' },
  ];
  const r = buildCitationsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCitationsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'See [1] for proof.' }];
  const r = buildCitationsForFiles(files);
  const md = renderCitationsBlock(r);
  assert.match(md, /^## ACADEMIC CITATIONS/);
});

test('renderCitationsBlock notes References section', () => {
  const files = [{ name: 'doc.md', extractedText: 'See [1].\n\n## References\n- foo\n' }];
  const r = buildCitationsForFiles(files);
  const md = renderCitationsBlock(r);
  assert.match(md, /References\/Bibliography/);
});

test('renderCitationsBlock empty when nothing surfaces', () => {
  assert.equal(renderCitationsBlock({ perFile: [] }), '');
  assert.equal(renderCitationsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCitationsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '[1]' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('ignores arbitrary bracketed non-citation text', () => {
  const r = extractCitations('Use [TODO] and [FIXME] markers.');
  // These are uppercase words, not patterns we expect
  assert.equal(r.citations.length, 0);
});
