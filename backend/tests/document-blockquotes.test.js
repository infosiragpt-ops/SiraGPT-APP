'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-blockquotes');
const { extractBlockquotes, buildBlockquotesForFiles, renderBlockquotesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractBlockquotes('').total, 0);
  assert.equal(extractBlockquotes(null).total, 0);
});

test('detects single-line blockquote', () => {
  const r = extractBlockquotes('Body.\n\n> This is a quoted line.');
  assert.ok(r.quotes.some((q) => /quoted line/.test(q.text)));
});

test('detects multi-line blockquote grouped', () => {
  const r = extractBlockquotes('Body.\n\n> Line one\n> Line two\n> Line three');
  assert.equal(r.quotes.length, 1);
  assert.ok(/Line one/.test(r.quotes[0].text));
});

test('detects attribution with em-dash', () => {
  const r = extractBlockquotes('Body.\n\n> Imagination is more important than knowledge.\n> — Albert Einstein');
  assert.ok(r.quotes.some((q) => /Einstein/.test(q.attribution || '')));
});

test('detects attribution with double-hyphen', () => {
  const r = extractBlockquotes('Body.\n\n> Stay hungry, stay foolish.\n> -- Steve Jobs');
  assert.ok(r.quotes.some((q) => q.attribution));
});

test('rejects too-short quote', () => {
  const r = extractBlockquotes('> hi');
  assert.equal(r.quotes.length, 0);
});

test('dedupes identical quotes', () => {
  const text = '> Same quote\n\n\n> Same quote';
  const r = extractBlockquotes(text);
  assert.ok(r.quotes.length <= 1);
});

test('caps quotes per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `\n\n> Quote number ${i} appearing here.\n`;
  const r = extractBlockquotes(text);
  assert.ok(r.quotes.length <= 12);
});

test('counts withAttribution', () => {
  const text = `> No author quote of some length.

---

> Authored quote of some length.
> — Some Author`;
  const r = extractBlockquotes(text);
  assert.ok(r.totals.withAttribution >= 1);
});

test('buildBlockquotesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '> First quote here.' },
    { name: 'b.md', extractedText: '> Second quote here.' },
  ];
  const r = buildBlockquotesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderBlockquotesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '> A nice quoted line.' }];
  const r = buildBlockquotesForFiles(files);
  const md = renderBlockquotesBlock(r);
  assert.match(md, /^## BLOCKQUOTES/);
});

test('renderBlockquotesBlock empty when nothing surfaces', () => {
  assert.equal(renderBlockquotesBlock({ perFile: [] }), '');
  assert.equal(renderBlockquotesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildBlockquotesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '> A quote of some length.' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('clips long quotes', () => {
  const long = 'A'.repeat(500);
  const r = extractBlockquotes(`> ${long}`);
  assert.ok(r.quotes[0].text.length <= 280);
});
