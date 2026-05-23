'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-spdx-complex');
const { extractSpdxComplex, buildSpdxComplexForFiles, renderSpdxComplexBlock, _internal } = engine;
const { looksLikeSpdxExpression } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSpdxComplex('').total, 0);
  assert.equal(extractSpdxComplex(null).total, 0);
});

test('looksLikeSpdxExpression: requires operator', () => {
  assert.equal(looksLikeSpdxExpression('MIT OR Apache-2.0'), true);
  assert.equal(looksLikeSpdxExpression('MIT'), false);
  assert.equal(looksLikeSpdxExpression(''), false);
});

test('detects OR expression', () => {
  const r = extractSpdxComplex('Licensed under MIT OR Apache-2.0 today');
  assert.ok(r.entries.some((e) => /MIT OR Apache-2\.0/.test(e.expression)));
});

test('detects AND expression', () => {
  const r = extractSpdxComplex('License: MIT AND BSD-3-Clause for this project');
  assert.ok(r.entries.some((e) => /MIT AND BSD-3-Clause/.test(e.expression)));
});

test('detects WITH exception', () => {
  const r = extractSpdxComplex('Apache-2.0 WITH LLVM-exception applies here');
  assert.ok(r.entries.some((e) => /Apache-2\.0 WITH LLVM-exception/.test(e.expression)));
});

test('detects SPDX-License-Identifier header with expression', () => {
  const r = extractSpdxComplex('// SPDX-License-Identifier: GPL-3.0-only WITH Classpath-exception-2.0');
  assert.ok(r.entries.some((e) => e.source === 'header'));
});

test('classifies operators correctly', () => {
  const r = extractSpdxComplex('MIT OR Apache-2.0');
  const e = r.entries.find((x) => /MIT OR/.test(x.expression));
  assert.equal(e.operators, 'OR');
});

test('rejects single license (no operator)', () => {
  const r = extractSpdxComplex('Licensed under MIT only.');
  assert.equal(r.entries.length, 0);
});

test('dedupes identical expressions', () => {
  const r = extractSpdxComplex('MIT OR Apache-2.0 here. MIT OR Apache-2.0 again.');
  assert.equal(r.entries.length, 1);
});

test('counts totals by operator', () => {
  const r = extractSpdxComplex('MIT OR Apache-2.0 and GPL-3.0 AND LGPL-2.1 and Apache-2.0 WITH LLVM-exception');
  assert.ok(r.totals.OR >= 1);
  assert.ok(r.totals.AND >= 1);
  assert.ok(r.totals.WITH >= 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `MIT-${i} OR Apache-${i}.0\n`;
  const r = extractSpdxComplex(text);
  assert.ok(r.entries.length <= 12);
});

test('buildSpdxComplexForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'MIT OR Apache-2.0' },
    { name: 'b.md', extractedText: 'GPL-3.0 AND BSD-3-Clause' },
  ];
  const r = buildSpdxComplexForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSpdxComplexBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'MIT OR Apache-2.0' }];
  const r = buildSpdxComplexForFiles(files);
  const md = renderSpdxComplexBlock(r);
  assert.match(md, /^## SPDX COMPLEX/);
});

test('renderSpdxComplexBlock empty when nothing surfaces', () => {
  assert.equal(renderSpdxComplexBlock({ perFile: [] }), '');
  assert.equal(renderSpdxComplexBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSpdxComplexForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'MIT OR Apache-2.0' },
  ]);
  assert.equal(r.perFile.length, 1);
});
