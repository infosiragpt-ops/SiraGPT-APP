'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-reading-time');
const { extractReadingTime, buildReadingTimeForFiles, renderReadingTimeBlock, _internal } = engine;
const { formatTime } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractReadingTime('').words, 0);
  assert.equal(extractReadingTime(null).words, 0);
});

test('formatTime: short / minutes / mixed', () => {
  assert.equal(formatTime(45), '45s');
  assert.equal(formatTime(60), '1m');
  assert.equal(formatTime(125), '2m 5s');
});

test('counts words accurately', () => {
  const r = extractReadingTime('hello world this is a test sentence');
  assert.equal(r.words, 7);
});

test('counts chars', () => {
  const text = 'hello world';
  const r = extractReadingTime(text);
  assert.equal(r.chars, 11);
});

test('returns three WPM bands', () => {
  const text = 'word '.repeat(500);
  const r = extractReadingTime(text);
  assert.ok(r.times.slow);
  assert.ok(r.times.average);
  assert.ok(r.times.fast);
});

test('fast time < average < slow', () => {
  const text = 'word '.repeat(1000);
  const r = extractReadingTime(text);
  assert.ok(r.times.fast.seconds < r.times.average.seconds);
  assert.ok(r.times.average.seconds < r.times.slow.seconds);
});

test('handles Unicode text', () => {
  const r = extractReadingTime('héllo wörld zürich café');
  assert.ok(r.words >= 4);
});

test('handles non-string extractedText', () => {
  const text = 'word '.repeat(50);
  const r = buildReadingTimeForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: text },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('buildReadingTimeForFiles aggregates per file', () => {
  const text = 'word '.repeat(100);
  const files = [
    { name: 'a.md', extractedText: text },
    { name: 'b.md', extractedText: text },
  ];
  const r = buildReadingTimeForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderReadingTimeBlock returns markdown when entries exist', () => {
  const text = 'word '.repeat(500);
  const files = [{ name: 'doc.md', extractedText: text }];
  const r = buildReadingTimeForFiles(files);
  const md = renderReadingTimeBlock(r);
  assert.match(md, /^## READING TIME/);
});

test('renderReadingTimeBlock empty when nothing surfaces', () => {
  assert.equal(renderReadingTimeBlock({ perFile: [] }), '');
  assert.equal(renderReadingTimeBlock(null), '');
});

test('formatted time includes m/s', () => {
  const text = 'word '.repeat(500);
  const r = extractReadingTime(text);
  assert.ok(/m|s/.test(r.times.average.formatted));
});
