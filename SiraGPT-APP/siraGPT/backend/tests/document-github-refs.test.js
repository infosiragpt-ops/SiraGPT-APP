'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-github-refs');
const { extractGithubRefs, buildGithubRefsForFiles, renderGithubRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractGithubRefs('').total, 0);
  assert.equal(extractGithubRefs(null).total, 0);
});

test('detects owner/repo#123 short ref', () => {
  const r = extractGithubRefs('See SiraGPT-ORg/siraGPT#42 for context');
  assert.ok(r.entries.some((e) => e.kind === 'short-ref' && e.number === 42));
});

test('detects owner/repo@sha', () => {
  const r = extractGithubRefs('Built from SiraGPT-ORg/siraGPT@abc1234');
  assert.ok(r.entries.some((e) => e.kind === 'repo-at-sha'));
});

test('detects GH-123', () => {
  const r = extractGithubRefs('Fix GH-1234 yesterday');
  assert.ok(r.entries.some((e) => e.kind === 'gh-num' && e.number === 1234));
});

test('detects github.com/owner/repo URL', () => {
  const r = extractGithubRefs('Repo at https://github.com/SiraGPT-ORg/siraGPT');
  assert.ok(r.entries.some((e) => e.kind === 'repo-url'));
});

test('detects issue URL', () => {
  const r = extractGithubRefs('https://github.com/SiraGPT-ORg/siraGPT/issues/42');
  assert.ok(r.entries.some((e) => e.kind === 'issue-url'));
});

test('detects PR URL', () => {
  const r = extractGithubRefs('https://github.com/SiraGPT-ORg/siraGPT/pull/100');
  assert.ok(r.entries.some((e) => e.kind === 'pr-url'));
});

test('detects @user mention', () => {
  const r = extractGithubRefs('cc @octocat for review');
  assert.ok(r.entries.some((e) => e.kind === 'mention' && e.user === 'octocat'));
});

test('rejects @everyone / @channel reserved mentions', () => {
  const r = extractGithubRefs('Ping @everyone and @channel');
  assert.equal(r.entries.filter((e) => e.kind === 'mention').length, 0);
});

test('dedupes identical refs', () => {
  const r = extractGithubRefs('a/b#42 and a/b#42 again');
  assert.equal(r.entries.filter((e) => e.kind === 'short-ref').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `GH-${1000 + i} `;
  const r = extractGithubRefs(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by kind', () => {
  const r = extractGithubRefs(
    'See SiraGPT-ORg/siraGPT#42 and GH-100 at https://github.com/SiraGPT-ORg/siraGPT/issues/5'
  );
  assert.ok(r.totals.shortRef >= 1);
  assert.ok(r.totals.ghNum >= 1);
  assert.ok(r.totals.issueUrl >= 1);
});

test('buildGithubRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'a/b#42' },
    { name: 'b.md', extractedText: 'c/d#100' },
  ];
  const r = buildGithubRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderGithubRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'changelog', extractedText: 'a/b#42' }];
  const r = buildGithubRefsForFiles(files);
  const md = renderGithubRefsBlock(r);
  assert.match(md, /^## GITHUB REFERENCES/);
});

test('renderGithubRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderGithubRefsBlock({ perFile: [] }), '');
  assert.equal(renderGithubRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildGithubRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'a/b#42' },
  ]);
  assert.equal(r.perFile.length, 1);
});
