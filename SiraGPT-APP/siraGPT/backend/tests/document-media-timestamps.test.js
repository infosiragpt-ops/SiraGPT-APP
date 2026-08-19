'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-media-timestamps');
const { extractMediaTimestamps, buildMediaTimestampsForFiles, renderMediaTimestampsBlock, _internal } = engine;
const { toSeconds, classify } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractMediaTimestamps('').total, 0);
  assert.equal(extractMediaTimestamps(null).total, 0);
});

test('toSeconds converts HH:MM:SS', () => {
  assert.equal(toSeconds('1:23:45'), 5025);
  assert.equal(toSeconds('12:34'), 754);
});

test('classify kinds', () => {
  assert.equal(classify('1:23:45'), 'hh-mm-ss');
  assert.equal(classify('12:34'), 'mm-ss');
});

test('detects [00:00:00] bracketed', () => {
  const r = extractMediaTimestamps('[00:01:23] Welcome to the episode');
  assert.ok(r.entries.some((e) => e.source === 'bracketed'));
});

test('detects (12:34) parenthesised MM:SS', () => {
  const r = extractMediaTimestamps('Discussed (12:34) topic');
  assert.ok(r.entries.some((e) => e.source === 'parenthesised'));
});

test('detects bare HH:MM:SS', () => {
  const r = extractMediaTimestamps('jump to 1:23:45 in the recording');
  assert.ok(r.entries.some((e) => e.timestamp === '1:23:45'));
});

test('detects SRT range', () => {
  const r = extractMediaTimestamps('00:00:01,000 --> 00:00:05,000');
  assert.ok(r.entries.some((e) => e.kind === 'subtitle-range' && e.source === 'srt'));
});

test('detects VTT range', () => {
  const r = extractMediaTimestamps('00:00:01.000 --> 00:00:05.000');
  assert.ok(r.entries.some((e) => e.kind === 'subtitle-range' && e.source === 'vtt'));
});

test('captures milliseconds in HH:MM:SS.mmm', () => {
  const r = extractMediaTimestamps('[00:01:23.456] timing precision');
  assert.ok(r.entries.length > 0);
});

test('computes seconds value', () => {
  const r = extractMediaTimestamps('[00:01:23] intro');
  const entry = r.entries.find((e) => e.source === 'bracketed');
  assert.equal(entry.seconds, 83);
});

test('dedupes identical timestamps', () => {
  const r = extractMediaTimestamps('[00:01:23] then [00:01:23] again');
  assert.equal(r.entries.filter((e) => e.timestamp === '00:01:23').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `[00:${i.toString().padStart(2, '0')}:00] `;
  const r = extractMediaTimestamps(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractMediaTimestamps('[00:01:23] and [12:34] and 1:23:45');
  assert.ok(r.totals['hh-mm-ss'] >= 1);
  assert.ok(r.totals['mm-ss'] >= 1);
});

test('buildMediaTimestampsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.srt', extractedText: '00:00:01,000 --> 00:00:05,000' },
    { name: 'b.md', extractedText: '[00:01:23] note' },
  ];
  const r = buildMediaTimestampsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMediaTimestampsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'episode.md', extractedText: '[00:01:23] intro' }];
  const r = buildMediaTimestampsForFiles(files);
  const md = renderMediaTimestampsBlock(r);
  assert.match(md, /^## MEDIA TIMESTAMPS/);
});

test('renderMediaTimestampsBlock empty when nothing surfaces', () => {
  assert.equal(renderMediaTimestampsBlock({ perFile: [] }), '');
  assert.equal(renderMediaTimestampsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMediaTimestampsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '[00:01:23] intro' },
  ]);
  assert.equal(r.perFile.length, 1);
});
