'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-social-urls');
const { extractSocialUrls, buildSocialUrlsForFiles, renderSocialUrlsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractSocialUrls('').total, 0);
  assert.equal(extractSocialUrls(null).total, 0);
});

test('detects twitter.com/user', () => {
  const r = extractSocialUrls('Follow on https://twitter.com/anthropic for updates.');
  assert.ok(r.entries.some((e) => e.kind === 'twitter' && e.handle === 'anthropic'));
});

test('detects x.com/user', () => {
  const r = extractSocialUrls('On x.com/anthropic regularly.');
  assert.ok(r.entries.some((e) => e.kind === 'twitter'));
});

test('detects instagram.com/user', () => {
  const r = extractSocialUrls('Photos at instagram.com/example_user');
  assert.ok(r.entries.some((e) => e.kind === 'instagram'));
});

test('detects linkedin.com/in/user', () => {
  const r = extractSocialUrls('Profile at linkedin.com/in/jane-doe online.');
  assert.ok(r.entries.some((e) => e.kind === 'linkedin'));
});

test('detects github.com/user/repo', () => {
  const r = extractSocialUrls('Code at github.com/SiraGPT-ORg/siraGPT');
  assert.ok(r.entries.some((e) => e.kind === 'github'));
});

test('detects youtube.com/@channel', () => {
  const r = extractSocialUrls('Channel at youtube.com/@anthropic');
  assert.ok(r.entries.some((e) => e.kind === 'youtube'));
});

test('detects tiktok.com/@user', () => {
  const r = extractSocialUrls('TikTok at tiktok.com/@example');
  assert.ok(r.entries.some((e) => e.kind === 'tiktok'));
});

test('detects reddit.com/r/sub', () => {
  const r = extractSocialUrls('Discussion in reddit.com/r/MachineLearning');
  assert.ok(r.entries.some((e) => e.kind === 'reddit'));
});

test('detects t.me telegram', () => {
  const r = extractSocialUrls('Join t.me/example today.');
  assert.ok(r.entries.some((e) => e.kind === 'telegram'));
});

test('detects discord.gg invite', () => {
  const r = extractSocialUrls('Discord: discord.gg/abc123');
  assert.ok(r.entries.some((e) => e.kind === 'discord'));
});

test('dedupes identical handles', () => {
  const r = extractSocialUrls('@anthropic at twitter.com/anthropic and again twitter.com/anthropic');
  assert.equal(r.entries.filter((e) => e.kind === 'twitter' && e.handle === 'anthropic').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `twitter.com/user${i} `;
  const r = extractSocialUrls(text);
  assert.ok(r.entries.length <= 20);
});

test('buildSocialUrlsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'twitter.com/anthropic' },
    { name: 'b.md', extractedText: 'github.com/openai' },
  ];
  const r = buildSocialUrlsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderSocialUrlsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'twitter.com/anthropic' }];
  const r = buildSocialUrlsForFiles(files);
  const md = renderSocialUrlsBlock(r);
  assert.match(md, /^## SOCIAL MEDIA/);
});

test('renderSocialUrlsBlock empty when nothing surfaces', () => {
  assert.equal(renderSocialUrlsBlock({ perFile: [] }), '');
  assert.equal(renderSocialUrlsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildSocialUrlsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'twitter.com/anthropic' },
  ]);
  assert.equal(r.perFile.length, 1);
});
