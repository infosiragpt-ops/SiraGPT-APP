'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldAutoFile,
  isStructuredContent,
  detectContentType,
  generateFileName,
  computeStatistics,
  ingestPastedContent,
  MIN_PASTE_LENGTH,
  STRUCTURED_THRESHOLD,
  FORMAT_EXTENSIONS,
  FORMAT_MIMES,
} = require('../src/services/smart-paste-bridge');

test('exports the documented surface', () => {
  for (const fn of [shouldAutoFile, isStructuredContent, detectContentType, generateFileName, computeStatistics, ingestPastedContent]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(typeof MIN_PASTE_LENGTH, 'number');
  assert.equal(typeof STRUCTURED_THRESHOLD, 'number');
  assert.ok(STRUCTURED_THRESHOLD > MIN_PASTE_LENGTH);
  assert.equal(typeof FORMAT_EXTENSIONS, 'object');
  assert.equal(typeof FORMAT_MIMES, 'object');
});

test('shouldAutoFile returns true only for strings at or above MIN_PASTE_LENGTH', () => {
  assert.equal(shouldAutoFile('x'.repeat(MIN_PASTE_LENGTH - 1)), false);
  assert.equal(shouldAutoFile('x'.repeat(MIN_PASTE_LENGTH)), true);
  assert.equal(shouldAutoFile(null), false);
  assert.equal(shouldAutoFile(undefined), false);
  assert.equal(shouldAutoFile(42), false);
});

test('detectContentType identifies JSON', () => {
  const out = detectContentType('{"hello": "world", "list": [1,2,3]}');
  assert.equal(out.format, 'json');
  assert.equal(out.confidence, 1);
});

test('detectContentType identifies shell scripts via shebang', () => {
  assert.equal(detectContentType('#!/bin/bash\necho hello').format, 'shell');
  assert.equal(detectContentType('#!/bin/zsh\nls').format, 'shell');
});

test('detectContentType identifies SQL queries', () => {
  assert.equal(detectContentType('SELECT * FROM users WHERE id = 1').format, 'sql');
});

test('detectContentType identifies markdown via heading prefix', () => {
  assert.equal(detectContentType('# Heading\n\nbody').format, 'markdown');
  assert.equal(detectContentType('## Sub').format, 'markdown');
});

test('detectContentType identifies XML / HTML', () => {
  assert.equal(detectContentType('<?xml version="1.0"?>').format, 'xml');
  assert.equal(detectContentType('<html><body>x</body></html>').format, 'html');
});

test('detectContentType identifies YAML via leading ---', () => {
  assert.equal(detectContentType('---\nkey: value').format, 'yaml');
});

test('detectContentType identifies CSV via comma columns', () => {
  const csv = 'name,email,role\nalice,a@b.com,admin\nbob,b@c.com,user';
  assert.equal(detectContentType(csv).format, 'csv');
});

test('detectContentType identifies TSV via tab columns', () => {
  const tsv = 'name\temail\nalice\ta@b.com\nbob\tb@c.com';
  assert.equal(detectContentType(tsv).format, 'tsv');
});

test('detectContentType identifies Python via import/def/class', () => {
  assert.equal(detectContentType('def foo():\n    return 1').format, 'python');
  assert.equal(detectContentType('import os\nimport sys').format, 'python');
  assert.equal(detectContentType('class Foo:\n    pass').format, 'python');
});

test('detectContentType identifies JS via const/function keywords (heuristic, not perfect)', () => {
  // `const ` + `function ` are JS-specific in the heuristic, so this lands
  // on javascript. Bare `import` (without preceding const/let/var/function)
  // overlaps with Python and falls into that branch first — that's a known
  // ambiguity captured here to lock the current detection order.
  assert.equal(detectContentType('const x = 1;\nfunction foo() {}').format, 'javascript');
  assert.equal(detectContentType('import { x } from "./y";').format, 'python', 'bare `import` resolves to python first by the heuristic ordering');
});

test('detectContentType falls back to plain with low confidence', () => {
  const out = detectContentType('just some prose without any structure or keywords');
  assert.equal(out.format, 'plain');
  assert.ok(out.confidence <= 0.5);
});

test('detectContentType tolerates null / non-string input', () => {
  assert.equal(detectContentType(null).format, 'plain');
  assert.equal(detectContentType(null).confidence, 0);
  assert.equal(detectContentType(undefined).format, 'plain');
  assert.equal(detectContentType(42).format, 'plain');
});

test('generateFileName produces deterministic name for same content + format', () => {
  // Date varies day-to-day but hash + extension are stable.
  const a = generateFileName('hello world content', 'plain');
  const b = generateFileName('hello world content', 'plain');
  assert.equal(a, b);
  assert.match(a, /^pasted_\d{4}-\d{2}-\d{2}_[a-f0-9]{8}\.txt$/);
});

test('generateFileName respects FORMAT_EXTENSIONS', () => {
  assert.match(generateFileName('{}', 'json'), /\.json$/);
  assert.match(generateFileName('def x(): pass', 'python'), /\.py$/);
  assert.match(generateFileName('# heading', 'markdown'), /\.md$/);
  assert.match(generateFileName('whatever', 'unknown_format'), /\.txt$/);
});

test('computeStatistics counts lines / words / chars', () => {
  const sample = 'one two three\nfour five\n\nsix';
  const stats = computeStatistics(sample);
  assert.equal(stats.charCount, sample.length);
  assert.equal(stats.lineCount, sample.split('\n').length);
  assert.equal(stats.nonEmptyLineCount, 3, 'two non-empty lines + "six" = 3');
  assert.equal(stats.wordCount, 6);
  assert.ok(stats.avgLineLength > 0);
});

test('computeStatistics tolerates empty / non-string input', () => {
  assert.deepEqual(computeStatistics(null), {});
  assert.deepEqual(computeStatistics(undefined), {});
});

test('ingestPastedContent rejects empty / null content', async () => {
  const empty = await ingestPastedContent('u', '');
  assert.equal(empty.autoFiled, false);
  assert.equal(empty.reason, 'empty_content');

  const nul = await ingestPastedContent('u', null);
  assert.equal(nul.autoFiled, false);
});

test('ingestPastedContent rejects content below MIN_PASTE_LENGTH', async () => {
  const small = await ingestPastedContent('u', 'too small');
  assert.equal(small.autoFiled, false);
  assert.equal(small.reason, 'below_threshold');
  assert.equal(small.threshold, MIN_PASTE_LENGTH);
});

test('ingestPastedContent auto-files structured JSON with detected format + mime', async () => {
  const payload = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ id: i, name: 'n' + i })) });
  const out = await ingestPastedContent('user-1', payload);
  assert.equal(out.autoFiled, true);
  assert.equal(out.format, 'json');
  assert.equal(out.mime, 'application/json');
  assert.equal(out.userId, 'user-1');
  assert.equal(out.isStructured, true);
  assert.equal(typeof out.charCount, 'number');
  assert.match(out.fileName, /\.json$/);
});

test('ingestPastedContent respects opts.fileName override', async () => {
  // Payload must trim to >= MIN_PASTE_LENGTH or it's rejected as below_threshold.
  const payload = JSON.stringify({ items: 'x'.repeat(120) });
  const out = await ingestPastedContent('u', payload, { fileName: 'override.json' });
  assert.equal(out.autoFiled, true);
  assert.equal(out.fileName, 'override.json');
});

test('ingestPastedContent stamps ingestedAt as ISO 8601', async () => {
  const payload = 'plain content '.repeat(20);
  const out = await ingestPastedContent('u', payload);
  assert.match(out.ingestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
