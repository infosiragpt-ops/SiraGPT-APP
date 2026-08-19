'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-media');
const { extractMedia, buildMediaForFiles, renderMediaBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMedia('').total, 0);
  assert.equal(extractMedia(null).total, 0);
});

test('detects audio mp3 filename', () => {
  const r = extractMedia('Listen to podcast.mp3 today.');
  assert.ok(r.entries.some((e) => e.kind === 'audio' && /podcast\.mp3/.test(e.value)));
});

test('detects video mp4 filename', () => {
  const r = extractMedia('Watch demo.mp4 here.');
  assert.ok(r.entries.some((e) => e.kind === 'video'));
});

test('detects HTML <audio src>', () => {
  const r = extractMedia('<audio src="/sounds/alert.mp3" controls>');
  assert.ok(r.entries.some((e) => e.kind === 'audio'));
});

test('detects HTML <video src>', () => {
  const r = extractMedia('<video src="/movies/clip.mp4" controls>');
  assert.ok(r.entries.some((e) => e.kind === 'video'));
});

test('detects timecode [12:34]', () => {
  const r = extractMedia('Skip to [12:34] for the demo.');
  assert.ok(r.entries.some((e) => e.kind === 'timecode'));
});

test('detects timecode 1:23:45', () => {
  const r = extractMedia('Discussion starts at 1:23:45 in the recording.');
  assert.ok(r.entries.some((e) => e.kind === 'timecode'));
});

test('detects episode marker S2E3', () => {
  const r = extractMedia('Watch S2E3 first.');
  assert.ok(r.entries.some((e) => e.kind === 'episode'));
});

test('detects Episode 5', () => {
  const r = extractMedia('Released Episode 5 today.');
  assert.ok(r.entries.some((e) => e.kind === 'episode'));
});

test('detects Spanish Capítulo', () => {
  const r = extractMedia('Capítulo 12 disponible.');
  assert.ok(r.entries.some((e) => e.kind === 'episode'));
});

test('dedupes identical entries', () => {
  const r = extractMedia('Listen to song.mp3 and again song.mp3');
  assert.equal(r.entries.filter((e) => /song\.mp3/.test(e.value)).length, 1);
});

test('caps entries per kind', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += `clip-${i}.mp4 `;
  const r = extractMedia(text);
  assert.ok(r.totals.video <= 10);
});

test('counts totals by kind', () => {
  const r = extractMedia('podcast.mp3 plus demo.mp4 plus [00:30]');
  assert.ok(r.totals.audio >= 1);
  assert.ok(r.totals.video >= 1);
  assert.ok(r.totals.timecode >= 1);
});

test('buildMediaForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'song.mp3' },
    { name: 'b.md', extractedText: 'demo.mp4' },
  ];
  const r = buildMediaForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMediaBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'podcast.mp3' }];
  const r = buildMediaForFiles(files);
  const md = renderMediaBlock(r);
  assert.match(md, /^## AUDIO/);
});

test('renderMediaBlock empty when nothing surfaces', () => {
  assert.equal(renderMediaBlock({ perFile: [] }), '');
  assert.equal(renderMediaBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMediaForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'song.mp3' },
  ]);
  assert.equal(r.perFile.length, 1);
});
