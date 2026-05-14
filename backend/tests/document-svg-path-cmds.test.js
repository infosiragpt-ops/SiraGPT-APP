'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-svg-path-cmds');
const { extractSvgPathCmds, buildSvgPathCmdsForFiles, renderSvgPathCmdsBlock, _internal } = engine;
const { summariseCommands } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractSvgPathCmds('').total, 0);
  assert.equal(extractSvgPathCmds(null).total, 0);
});

test('summariseCommands counts each letter', () => {
  const r = summariseCommands('M0 0 L10 10 Z');
  assert.equal(r.M, 1);
  assert.equal(r.L, 1);
  assert.equal(r.Z, 1);
});

test('detects path with d="..."', () => {
  const r = extractSvgPathCmds('<path d="M0,0 L100,100 Z" />');
  assert.ok(r.entries.length >= 1);
});

test('captures totalCommands count', () => {
  const r = extractSvgPathCmds('<path d="M0,0 L10,10 L20,20 Z" />');
  assert.equal(r.entries[0].totalCommands, 4);
});

test('captures commandTypes', () => {
  const r = extractSvgPathCmds('<path d="M0,0 L10,10 Z" />');
  assert.equal(r.entries[0].commandTypes, 3);
});

test('detects cubic bezier C', () => {
  const r = extractSvgPathCmds('<path d="M0,0 C10,10 20,20 30,30" />');
  assert.ok(r.totals['cubic-bezier'] >= 1);
});

test('detects arc A', () => {
  const r = extractSvgPathCmds('<path d="M0,0 A50,50 0 0 1 100,100" />');
  assert.ok(r.totals.arc >= 1);
});

test('detects lowercase relative commands', () => {
  const r = extractSvgPathCmds('<path d="m0,0 l10,10 z" />');
  assert.ok(r.totals['moveto-rel'] >= 1);
});

test('dedupes identical paths', () => {
  const r = extractSvgPathCmds('<path d="M0,0 L100,100 Z" />\n<path d="M0,0 L100,100 Z" />');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `<path d="M${i},0 L${i},10 Z" />\n`;
  const r = extractSvgPathCmds(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals across commands', () => {
  const r = extractSvgPathCmds('<path d="M0,0 L10,10 C20,20 30,30 40,40 Z" />');
  assert.ok(r.totals.moveto >= 1);
  assert.ok(r.totals.lineto >= 1);
  assert.ok(r.totals['cubic-bezier'] >= 1);
});

test('buildSvgPathCmdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.svg', extractedText: '<path d="M0,0 L10,10" />' },
    { name: 'b.svg', extractedText: '<path d="C20,20 30,30 40,40" />' },
  ];
  const r = buildSvgPathCmdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSvgPathCmdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'icon.svg', extractedText: '<path d="M0,0 L10,10 Z" />' }];
  const r = buildSvgPathCmdsForFiles(files);
  const md = renderSvgPathCmdsBlock(r);
  assert.match(md, /^## SVG PATH/);
});

test('renderSvgPathCmdsBlock empty when nothing surfaces', () => {
  assert.equal(renderSvgPathCmdsBlock({ perFile: [] }), '');
  assert.equal(renderSvgPathCmdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSvgPathCmdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '<path d="M0,0 L10,10 Z" />' },
  ]);
  assert.equal(r.perFile.length, 1);
});
