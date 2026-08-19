'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-emoji-shortcodes');
const { extractEmojiShortcodes, buildEmojiShortcodesForFiles, renderEmojiShortcodesBlock, _internal } = engine;
const { classifyShortcode } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractEmojiShortcodes('').total, 0);
  assert.equal(extractEmojiShortcodes(null).total, 0);
});

test('classifyShortcode: sentiment buckets', () => {
  assert.equal(classifyShortcode('rocket'), 'positive');
  assert.equal(classifyShortcode('warning'), 'caution');
  assert.equal(classifyShortcode('thinking'), 'neutral');
});

test('detects :rocket: shortcode', () => {
  const r = extractEmojiShortcodes('Launch :rocket: today!');
  assert.ok(r.entries.some((e) => e.code === 'rocket'));
});

test('detects :fire: shortcode', () => {
  const r = extractEmojiShortcodes('This is :fire: amazing');
  assert.ok(r.entries.some((e) => e.code === 'fire'));
});

test('detects :warning: as caution', () => {
  const r = extractEmojiShortcodes(':warning: deprecated API');
  assert.ok(r.entries.some((e) => e.kind === 'caution'));
});

test('detects unicode emoji', () => {
  const r = extractEmojiShortcodes('Launch 🚀 today!');
  assert.ok(r.entries.some((e) => e.source === 'unicode'));
});

test('detects fire emoji 🔥', () => {
  const r = extractEmojiShortcodes('This is 🔥');
  assert.ok(r.entries.some((e) => e.source === 'unicode'));
});

test('detects gitmoji-style :sparkles:', () => {
  const r = extractEmojiShortcodes(':sparkles: new feature');
  assert.ok(r.entries.some((e) => e.kind === 'gitmoji' || e.kind === 'positive'));
});

test('detects :bug: as caution', () => {
  const r = extractEmojiShortcodes(':bug: fixing this');
  assert.ok(r.entries.some((e) => e.code === 'bug' && e.kind === 'caution'));
});

test('dedupes identical entries', () => {
  const r = extractEmojiShortcodes(':rocket: here and :rocket: again');
  assert.equal(r.entries.filter((e) => e.code === 'rocket').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `:code${i}: `;
  const r = extractEmojiShortcodes(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by sentiment', () => {
  const r = extractEmojiShortcodes(':rocket: and :warning: and :thinking:');
  assert.ok(r.totals.positive >= 1);
  assert.ok(r.totals.caution >= 1);
  assert.ok(r.totals.neutral >= 1);
});

test('buildEmojiShortcodesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: ':rocket:' },
    { name: 'b', extractedText: ':fire:' },
  ];
  const r = buildEmojiShortcodesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderEmojiShortcodesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'commit.md', extractedText: ':rocket: launch' }];
  const r = buildEmojiShortcodesForFiles(files);
  const md = renderEmojiShortcodesBlock(r);
  assert.match(md, /^## EMOJI/);
});

test('renderEmojiShortcodesBlock empty when nothing surfaces', () => {
  assert.equal(renderEmojiShortcodesBlock({ perFile: [] }), '');
  assert.equal(renderEmojiShortcodesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildEmojiShortcodesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: ':rocket:' },
  ]);
  assert.equal(r.perFile.length, 1);
});
