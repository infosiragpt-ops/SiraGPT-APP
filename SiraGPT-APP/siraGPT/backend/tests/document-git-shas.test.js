'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-git-shas');
const { extractGitShas, buildGitShasForFiles, renderGitShasBlock, _internal } = engine;
const { isHexPlaceholder, classifyLength } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractGitShas('').total, 0);
  assert.equal(extractGitShas(null).total, 0);
});

test('isHexPlaceholder: matches all-zero / all-f', () => {
  assert.equal(isHexPlaceholder('0000000'), true);
  assert.equal(isHexPlaceholder('ffffffff'), true);
  assert.equal(isHexPlaceholder('abc1234'), false);
});

test('classifyLength: short / medium / full', () => {
  assert.equal(classifyLength('abc1234'), 'short');
  assert.equal(classifyLength('abc1234abc12'), 'short');
  assert.equal(classifyLength('abc1234abc123'), 'medium');
  assert.equal(classifyLength('a'.repeat(40)), 'full');
});

test('detects "commit abc1234"', () => {
  const r = extractGitShas('See commit abc1234 for details');
  assert.ok(r.entries.some((e) => e.sha === 'abc1234'));
});

test('detects "git checkout deadbeef"', () => {
  const r = extractGitShas('Run: git checkout deadbeef99');
  assert.ok(r.entries.some((e) => /deadbeef/.test(e.sha)));
});

test('detects PR-style "Fixes abc1234"', () => {
  const r = extractGitShas('Fixes abc1234abc and closes 0123456789');
  assert.ok(r.entries.some((e) => e.source === 'pr-ref'));
});

test('detects standalone 40-char SHA', () => {
  const r = extractGitShas('SHA: aabbccddeeff00112233445566778899aabbccdd');
  assert.ok(r.entries.some((e) => e.length === 'full'));
});

test('rejects all-zero placeholder', () => {
  const r = extractGitShas('commit 0000000');
  assert.equal(r.entries.length, 0);
});

test('rejects all-f placeholder', () => {
  const r = extractGitShas('commit ffffffffff');
  assert.equal(r.entries.length, 0);
});

test('dedupes identical SHAs (case-insensitive)', () => {
  const r = extractGitShas('commit ABC1234 and again commit abc1234');
  assert.equal(r.entries.filter((e) => e.sha === 'abc1234').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) {
    const s = (i + 1).toString(16).padStart(7, '0').slice(-7);
    text += `commit ${s} `;
  }
  const r = extractGitShas(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by length', () => {
  const r = extractGitShas(
    'commit abc1234 and SHA: aabbccddeeff00112233445566778899aabbccdd'
  );
  assert.ok(r.totals.short >= 1);
  assert.ok(r.totals.full >= 1);
});

test('buildGitShasForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'commit abc1234' },
    { name: 'b.md', extractedText: 'commit deadbee' },
  ];
  const r = buildGitShasForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGitShasBlock returns markdown when entries exist', () => {
  const files = [{ name: 'changelog', extractedText: 'commit abc1234' }];
  const r = buildGitShasForFiles(files);
  const md = renderGitShasBlock(r);
  assert.match(md, /^## GIT COMMIT/);
});

test('renderGitShasBlock empty when nothing surfaces', () => {
  assert.equal(renderGitShasBlock({ perFile: [] }), '');
  assert.equal(renderGitShasBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGitShasForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'commit abc1234' },
  ]);
  assert.equal(r.perFile.length, 1);
});
