'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-pull-quotes');
const { extractPullQuotes, buildPullQuotesForFiles, renderPullQuotesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractPullQuotes('').total, 0);
  assert.equal(extractPullQuotes(null).total, 0);
});

test('detects dash attribution "Quote." — Author', () => {
  const r = extractPullQuotes('"Stay hungry, stay foolish." — Steve Jobs');
  assert.ok(r.entries.some((e) => e.kind === 'dash' && /Steve Jobs/.test(e.author)));
});

test('detects em-dash unicode', () => {
  const r = extractPullQuotes('"Innovation distinguishes between a leader and a follower." — Steve Jobs');
  assert.ok(r.entries.some((e) => e.kind === 'dash'));
});

test('detects double-hyphen attribution', () => {
  const r = extractPullQuotes('"Time flies like an arrow." -- Groucho Marx');
  assert.ok(r.entries.some((e) => e.kind === 'dash'));
});

test('detects parenthetical (Author, Year)', () => {
  const r = extractPullQuotes('"Climate is changing rapidly." (Smith, 2023)');
  assert.ok(r.entries.some((e) => e.kind === 'paren'));
});

test('detects et al. parenthetical', () => {
  const r = extractPullQuotes('"Distributed systems are hard." (Lamport et al., 2020)');
  assert.ok(r.entries.some((e) => e.kind === 'paren'));
});

test('detects "said X" pattern', () => {
  const r = extractPullQuotes('"We need to ship faster," said Alice Johnson.');
  assert.ok(r.entries.some((e) => e.kind === 'said'));
});

test('detects "X said" pattern via said keyword', () => {
  const r = extractPullQuotes('"This is critical," wrote Bob Smith last year.');
  assert.ok(r.entries.some((e) => e.kind === 'said'));
});

test('truncates very long quotes', () => {
  const longQuote = 'X'.repeat(200);
  const r = extractPullQuotes(`"${longQuote}" — Alice`);
  for (const e of r.entries) {
    assert.ok(e.quote.length <= 121);
  }
});

test('dedupes identical quote+author', () => {
  const r = extractPullQuotes('"Hello world." — Alice. Later: "Hello world." — Alice.');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `"Quote number ${i} here." — Author${i}\n`;
  const r = extractPullQuotes(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractPullQuotes(
    '"A." — Alice. "B." (Smith, 2023). "C," said Bob.'
  );
  assert.ok(r.totals.dash >= 1);
  assert.ok(r.totals.paren >= 1);
  assert.ok(r.totals.said >= 1);
});

test('buildPullQuotesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '"Quote one here." — Alice' },
    { name: 'b.md', extractedText: '"Quote two here." — Bob' },
  ];
  const r = buildPullQuotesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderPullQuotesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'essay.md', extractedText: '"Quote text here." — Alice' }];
  const r = buildPullQuotesForFiles(files);
  const md = renderPullQuotesBlock(r);
  assert.match(md, /^## PULL QUOTES/);
});

test('renderPullQuotesBlock empty when nothing surfaces', () => {
  assert.equal(renderPullQuotesBlock({ perFile: [] }), '');
  assert.equal(renderPullQuotesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildPullQuotesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '"Hello there." — Alice' },
  ]);
  assert.equal(r.perFile.length, 1);
});
