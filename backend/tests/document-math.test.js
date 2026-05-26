'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-math');
const { extractMath, buildMathForFiles, renderMathBlock, _internal } = engine;
const { looksLikeMath } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractMath('').total, 0);
  assert.equal(extractMath(null).total, 0);
});

test('looksLikeMath: requires math indicator', () => {
  assert.equal(looksLikeMath('E = mc^2'), true);
  assert.equal(looksLikeMath('\\frac{1}{2}'), true);
  assert.equal(looksLikeMath('just text'), false);
});

test('detects inline $E = mc^2$', () => {
  const r = extractMath('Einstein showed $E = mc^2$ is exact.');
  assert.ok(r.entries.some((e) => e.kind === 'inline' && /mc\^2/.test(e.value)));
});

test('detects display $$\\sum$$', () => {
  const r = extractMath('$$\\sum_{i=1}^n i$$');
  assert.ok(r.entries.some((e) => e.kind === 'display'));
});

test('detects \\(...\\) inline', () => {
  const r = extractMath('Consider \\(\\alpha = 0.05\\) significance.');
  assert.ok(r.entries.some((e) => e.kind === 'inline'));
});

test('detects \\[...\\] display', () => {
  const r = extractMath('We get \\[x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\\] formula.');
  assert.ok(r.entries.some((e) => e.kind === 'display'));
});

test('detects equation environment', () => {
  const r = extractMath('\\begin{equation}\nE = mc^2\n\\end{equation}');
  assert.ok(r.entries.some((e) => e.kind === 'environment'));
});

test('detects align environment', () => {
  const r = extractMath('\\begin{align}\na &= b + c \\\\\nd &= e + f\n\\end{align}');
  assert.ok(r.entries.some((e) => e.kind === 'environment'));
});

test('rejects empty inline $$', () => {
  const r = extractMath('Use $.text$ for normal');
  // ".text" has no math indicator
  assert.equal(r.entries.length, 0);
});

test('dedupes identical expressions', () => {
  const r = extractMath('$x = 1$ and again $x = 1$.');
  assert.equal(r.entries.filter((e) => /x = 1/.test(e.value)).length, 1);
});

test('counts totals by kind', () => {
  const r = extractMath('$a^2$ and $$\\int dx$$ and \\begin{equation}E=mc^2\\end{equation}');
  assert.ok(r.totals.inline >= 1);
  assert.ok(r.totals.display >= 1);
  assert.ok(r.totals.environment >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `$x_${i} = ${i}^2$ `;
  const r = extractMath(text);
  assert.ok(r.entries.length <= 24);
});

test('buildMathForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '$E = mc^2$' },
    { name: 'b.md', extractedText: '$F = ma$' },
  ];
  const r = buildMathForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMathBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '$E = mc^2$' }];
  const r = buildMathForFiles(files);
  const md = renderMathBlock(r);
  assert.match(md, /^## MATH EXPRESSIONS/);
});

test('renderMathBlock empty when nothing surfaces', () => {
  assert.equal(renderMathBlock({ perFile: [] }), '');
  assert.equal(renderMathBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMathForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '$E = mc^2$' },
  ]);
  assert.equal(r.perFile.length, 1);
});
