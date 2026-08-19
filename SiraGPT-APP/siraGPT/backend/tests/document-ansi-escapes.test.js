'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ansi-escapes');
const { extractAnsiEscapes, buildAnsiEscapesForFiles, renderAnsiEscapesBlock, _internal } = engine;
const { decodeSgr } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractAnsiEscapes('').total, 0);
  assert.equal(extractAnsiEscapes(null).total, 0);
});

test('decodeSgr: standard SGR codes', () => {
  assert.equal(decodeSgr('0'), 'reset');
  assert.equal(decodeSgr('1'), 'bold');
  assert.equal(decodeSgr('31'), 'fg-red');
  assert.equal(decodeSgr('42'), 'bg-green');
});

test('detects SGR red foreground', () => {
  const r = extractAnsiEscapes('Error: \\x1b[31m FAIL \\x1b[0m');
  assert.ok(r.entries.some((e) => e.kind === 'sgr' && /fg-red/.test(e.decoded)));
});

test('detects compound SGR (bold + color)', () => {
  const r = extractAnsiEscapes('\\x1b[1;33m Warning \\x1b[0m');
  assert.ok(r.entries.some((e) => /bold/.test(e.decoded)));
});

test('detects reset code', () => {
  const r = extractAnsiEscapes('\\x1b[0m');
  assert.ok(r.entries.some((e) => /reset/.test(e.decoded)));
});

test('detects bright foreground', () => {
  const r = extractAnsiEscapes('\\x1b[91m bright red \\x1b[0m');
  assert.ok(r.entries.some((e) => /bright-red/.test(e.decoded)));
});

test('detects cursor movement', () => {
  const r = extractAnsiEscapes('\\x1b[2J clear screen');
  assert.ok(r.entries.some((e) => e.kind === 'cursor'));
});

test('detects OSC title set', () => {
  const r = extractAnsiEscapes('\\x1b]0;My Window Title\\x07');
  assert.ok(r.entries.some((e) => e.kind === 'osc'));
});

test('detects \\033 form', () => {
  const r = extractAnsiEscapes('\\033[32m success \\033[0m');
  assert.ok(r.entries.some((e) => /green/.test(e.decoded)));
});

test('dedupes identical entries', () => {
  const r = extractAnsiEscapes('\\x1b[31m and again \\x1b[31m');
  assert.equal(r.entries.filter((e) => e.kind === 'sgr').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 30; i < 50; i++) text += `\\x1b[${i}m `;
  const r = extractAnsiEscapes(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractAnsiEscapes('\\x1b[31m and \\x1b[2J and \\x1b]0;title\\x07');
  assert.ok(r.totals.sgr >= 1);
  assert.ok(r.totals.cursor >= 1);
  assert.ok(r.totals.osc >= 1);
});

test('buildAnsiEscapesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.log', extractedText: '\\x1b[31m red' },
    { name: 'b.log', extractedText: '\\x1b[32m green' },
  ];
  const r = buildAnsiEscapesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderAnsiEscapesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: '\\x1b[31m FAIL' }];
  const r = buildAnsiEscapesForFiles(files);
  const md = renderAnsiEscapesBlock(r);
  assert.match(md, /^## ANSI/);
});

test('renderAnsiEscapesBlock empty when nothing surfaces', () => {
  assert.equal(renderAnsiEscapesBlock({ perFile: [] }), '');
  assert.equal(renderAnsiEscapesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildAnsiEscapesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '\\x1b[31m red' },
  ]);
  assert.equal(r.perFile.length, 1);
});
