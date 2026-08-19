'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-latex-commands');
const { extractLatexCommands, buildLatexCommandsForFiles, renderLatexCommandsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractLatexCommands('').total, 0);
  assert.equal(extractLatexCommands(null).total, 0);
});

test('detects \\section command', () => {
  const r = extractLatexCommands('\\section{Introduction}');
  assert.ok(r.entries.some((e) => e.kind === 'structural' && e.cmd === 'section'));
});

test('detects \\chapter command', () => {
  const r = extractLatexCommands('\\chapter{Methods}');
  assert.ok(r.entries.some((e) => e.cmd === 'chapter'));
});

test('detects \\cite command', () => {
  const r = extractLatexCommands('See \\cite{smith2023} for details');
  assert.ok(r.entries.some((e) => e.kind === 'citation'));
});

test('detects \\citep (parenthetical)', () => {
  const r = extractLatexCommands('Result follows \\citep{jones2020}');
  assert.ok(r.entries.some((e) => e.cmd === 'citep'));
});

test('detects \\ref command', () => {
  const r = extractLatexCommands('See Eq. \\ref{eq:main}');
  assert.ok(r.entries.some((e) => e.kind === 'reference'));
});

test('detects \\begin{equation}', () => {
  const r = extractLatexCommands('\\begin{equation} x = 1 \\end{equation}');
  assert.ok(r.entries.some((e) => e.kind === 'environment' && e.cmd === 'equation'));
});

test('detects \\usepackage', () => {
  const r = extractLatexCommands('\\usepackage{amsmath,amssymb}');
  assert.ok(r.entries.some((e) => e.kind === 'package'));
});

test('detects display math $$..$$', () => {
  const r = extractLatexCommands('Result: \\[ x = y + 1 \\]');
  assert.ok(r.entries.some((e) => e.kind === 'math'));
});

test('detects inline math $..$', () => {
  const r = extractLatexCommands('Let $x = 1$ be the value.');
  assert.ok(r.entries.some((e) => e.kind === 'math'));
});

test('dedupes identical entries', () => {
  const r = extractLatexCommands('\\section{Intro} \\section{Intro}');
  assert.equal(r.entries.filter((e) => e.kind === 'structural').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `\\section{S${i}}\n`;
  const r = extractLatexCommands(text);
  assert.ok(r.entries.length <= 22);
});

test('counts totals by kind', () => {
  const r = extractLatexCommands(
    '\\section{X} \\cite{a} \\ref{b} \\begin{eq} \\usepackage{ams}'
  );
  assert.ok(r.totals.structural >= 1);
  assert.ok(r.totals.citation >= 1);
  assert.ok(r.totals.reference >= 1);
  assert.ok(r.totals.package >= 1);
});

test('buildLatexCommandsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.tex', extractedText: '\\section{X}' },
    { name: 'b.tex', extractedText: '\\cite{ref1}' },
  ];
  const r = buildLatexCommandsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderLatexCommandsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'paper.tex', extractedText: '\\section{Intro}' }];
  const r = buildLatexCommandsForFiles(files);
  const md = renderLatexCommandsBlock(r);
  assert.match(md, /^## LATEX/);
});

test('renderLatexCommandsBlock empty when nothing surfaces', () => {
  assert.equal(renderLatexCommandsBlock({ perFile: [] }), '');
  assert.equal(renderLatexCommandsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildLatexCommandsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '\\section{X}' },
  ]);
  assert.equal(r.perFile.length, 1);
});
