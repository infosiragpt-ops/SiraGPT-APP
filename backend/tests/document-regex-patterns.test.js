'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-regex-patterns');
const { extractRegexPatterns, buildRegexPatternsForFiles, renderRegexPatternsBlock, _internal } = engine;
const { looksLikeRegex } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRegexPatterns('').total, 0);
  assert.equal(extractRegexPatterns(null).total, 0);
});

test('looksLikeRegex: requires regex constructs', () => {
  assert.equal(looksLikeRegex('^foo$'), true);
  assert.equal(looksLikeRegex('a+b*'), true);
  assert.equal(looksLikeRegex('hello'), false);
});

test('detects JS-style /pattern/flags', () => {
  const r = extractRegexPatterns('Match with /^foo.*$/g pattern.');
  assert.ok(r.patterns.some((p) => p.kind === 'slash' && /foo/.test(p.pattern)));
});

test('detects re.compile pattern', () => {
  const r = extractRegexPatterns('Use re.compile(r"^[a-z]+$") for matching.');
  assert.ok(r.patterns.some((p) => p.kind === 'recompile'));
});

test('detects backtick raw regex', () => {
  const r = extractRegexPatterns('Pattern: `^prefix.*$`');
  assert.ok(r.patterns.some((p) => p.kind === 'backtick'));
});

test('rejects URLs as slash regex', () => {
  const r = extractRegexPatterns('Visit https://example.com/path/to/page');
  assert.equal(r.patterns.filter((p) => /example/.test(p.pattern)).length, 0);
});

test('rejects file paths as regex', () => {
  const r = extractRegexPatterns('Edit /src/foo/bar.js today');
  // Filtered because it doesn't look like regex
  assert.equal(r.patterns.length, 0);
});

test('dedupes identical patterns', () => {
  const r = extractRegexPatterns('Use /^foo$/ and /^foo$/ again');
  assert.equal(r.patterns.length, 1);
});

test('caps patterns per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `/pattern${i}.*$/ `;
  const r = extractRegexPatterns(text);
  assert.ok(r.patterns.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractRegexPatterns('/^foo$/ and re.compile(r"^bar$") and `^baz.*$`');
  assert.ok(r.totals.slash >= 1);
  assert.ok(r.totals.recompile >= 1);
  assert.ok(r.totals.backtick >= 1);
});

test('captures flags', () => {
  const r = extractRegexPatterns('Use /^foo$/gim for matching.');
  const slash = r.patterns.find((p) => p.kind === 'slash');
  assert.ok(slash);
  assert.ok(/g/.test(slash.flags));
});

test('buildRegexPatternsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '/^foo$/' },
    { name: 'b.md', extractedText: 're.compile(r"^bar$")' },
  ];
  const r = buildRegexPatternsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRegexPatternsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: '/^foo$/' }];
  const r = buildRegexPatternsForFiles(files);
  const md = renderRegexPatternsBlock(r);
  assert.match(md, /^## REGEX PATTERNS/);
});

test('renderRegexPatternsBlock empty when nothing surfaces', () => {
  assert.equal(renderRegexPatternsBlock({ perFile: [] }), '');
  assert.equal(renderRegexPatternsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRegexPatternsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '/^foo$/' },
  ]);
  assert.equal(r.perFile.length, 1);
});
