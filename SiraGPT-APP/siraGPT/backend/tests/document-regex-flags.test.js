'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-regex-flags');
const { extractRegexFlags, buildRegexFlagsForFiles, renderRegexFlagsBlock, _internal } = engine;
const { analyzeFlags, previewPattern } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRegexFlags('').total, 0);
  assert.equal(extractRegexFlags(null).total, 0);
});

test('analyzeFlags resolves single-letter codes', () => {
  assert.deepEqual(analyzeFlags('gi'), ['global', 'insensitive']);
  assert.deepEqual(analyzeFlags('su'), ['dotall', 'unicode']);
  assert.deepEqual(analyzeFlags(''), []);
});

test('previewPattern truncates long', () => {
  assert.equal(previewPattern('short'), 'short');
  const long = 'a'.repeat(60);
  assert.ok(previewPattern(long).includes('…'));
});

test('detects regex literal /abc/g', () => {
  const r = extractRegexFlags('const re = /abc/g;');
  assert.ok(r.entries.some((e) => e.kind === 'literal'));
});

test('detects flags global / insensitive / multiline', () => {
  const r = extractRegexFlags('const re = /test/gim;');
  assert.ok(r.totals.global >= 1);
  assert.ok(r.totals.insensitive >= 1);
  assert.ok(r.totals.multiline >= 1);
});

test('detects unicode and sticky flags', () => {
  const r = extractRegexFlags('const re = /foo/uy;');
  assert.ok(r.totals.unicode >= 1);
  assert.ok(r.totals.sticky >= 1);
});

test('detects new RegExp constructor', () => {
  const r = extractRegexFlags('const re = new RegExp("pattern", "gi");');
  assert.ok(r.entries.some((e) => e.kind === 'constructor'));
  assert.ok(r.totals.global >= 1);
});

test('detects lookahead feature', () => {
  const r = extractRegexFlags('const re = /foo(?=bar)/;');
  assert.ok(r.totals.lookahead >= 1);
});

test('detects lookbehind feature', () => {
  const r = extractRegexFlags('const re = /(?<=foo)bar/;');
  assert.ok(r.totals.lookbehind >= 1);
});

test('detects negative lookahead', () => {
  const r = extractRegexFlags('const re = /foo(?!bar)/;');
  assert.ok(r.totals.negLookahead >= 1);
});

test('detects named groups', () => {
  const r = extractRegexFlags('const re = /(?<year>\\d{4})/;');
  assert.ok(r.totals.namedGroup >= 1);
});

test('detects backreferences', () => {
  const r = extractRegexFlags('const re = /(.)\\1/;');
  assert.ok(r.totals.backref >= 1);
});

test('detects unicode property escapes', () => {
  const r = extractRegexFlags('const re = /\\p{L}+/u;');
  assert.ok(r.totals.unicodeProp >= 1);
});

test('detects word boundary anchors', () => {
  const r = extractRegexFlags('const re = /\\bword\\b/;');
  assert.ok(r.totals.wordBoundary >= 1);
});

test('dedupes identical literals', () => {
  const r = extractRegexFlags('const a = /x/; const b = /x/;');
  assert.equal(r.entries.filter((e) => e.kind === 'literal' && e.pattern === 'x').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `const r${i} = /pat${i}/g; `;
  const r = extractRegexFlags(text);
  assert.ok(r.entries.length <= 22);
});

test('counts literal vs constructor', () => {
  const r = extractRegexFlags('const a = /x/g; const b = new RegExp("y", "i");');
  assert.ok(r.totals.literal >= 1);
  assert.ok(r.totals.constructor >= 1);
});

test('buildRegexFlagsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.js', extractedText: 'const a = /x/g;' },
    { name: 'b.js', extractedText: 'const b = /y/i;' },
  ];
  const r = buildRegexFlagsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRegexFlagsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'r.js', extractedText: 'const r = /test/gi;' }];
  const r = buildRegexFlagsForFiles(files);
  const md = renderRegexFlagsBlock(r);
  assert.match(md, /^## REGEX/);
});

test('renderRegexFlagsBlock empty when nothing surfaces', () => {
  assert.equal(renderRegexFlagsBlock({ perFile: [] }), '');
  assert.equal(renderRegexFlagsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRegexFlagsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'const r = /x/;' },
  ]);
  assert.equal(r.perFile.length, 1);
});
