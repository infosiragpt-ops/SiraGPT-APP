'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-vcs-refs');
const { extractVcsRefs, buildVcsRefsForFiles, renderVcsRefsBlock, _internal } = engine;
const { isLikelyRepoRef } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractVcsRefs('').total, 0);
  assert.equal(extractVcsRefs(null).total, 0);
});

test('isLikelyRepoRef: rejects file paths', () => {
  assert.equal(isLikelyRepoRef('owner/repo'), true);
  assert.equal(isLikelyRepoRef('src/foo.js'), false);
});

test('detects commit with prefix', () => {
  const r = extractVcsRefs('Fixed in commit a1b2c3d4e5f');
  assert.ok(r.refs.some((rf) => rf.kind === 'commit'));
});

test('detects 40-char full SHA', () => {
  const sha = 'a'.repeat(40);
  const r = extractVcsRefs(`Released ${sha} today`);
  assert.ok(r.refs.some((rf) => rf.kind === 'commit'));
});

test('detects #123', () => {
  const r = extractVcsRefs('Fixed in #123 yesterday.');
  assert.ok(r.refs.some((rf) => rf.kind === 'issue' && rf.value === '#123'));
});

test('detects GH-456', () => {
  const r = extractVcsRefs('Tracking via GH-456 in queue.');
  assert.ok(r.refs.some((rf) => rf.kind === 'issue' && /GH-456/.test(rf.value)));
});

test('detects PR-#789', () => {
  const r = extractVcsRefs('See PR-#789 for details.');
  assert.ok(r.refs.some((rf) => rf.kind === 'issue'));
});

test('detects owner/repo', () => {
  const r = extractVcsRefs('Mirror at SiraGPT-ORg/siraGPT today.');
  assert.ok(r.refs.some((rf) => rf.kind === 'repo' && /siraGPT/i.test(rf.value)));
});

test('detects "branch: feature/foo"', () => {
  const r = extractVcsRefs('Working on branch: feature/login-flow');
  assert.ok(r.refs.some((rf) => rf.kind === 'branch'));
});

test('detects "on main"', () => {
  const r = extractVcsRefs('Released on branch main yesterday.');
  assert.ok(r.refs.some((rf) => rf.kind === 'branch'));
});

test('detects "tag: v1.2.3"', () => {
  const r = extractVcsRefs('Released tag: v1.2.3 yesterday.');
  assert.ok(r.refs.some((rf) => rf.kind === 'tag'));
});

test('dedupes identical refs', () => {
  const r = extractVcsRefs('Fixed #123 and #123 again.');
  assert.equal(r.refs.filter((rf) => rf.kind === 'issue' && rf.value === '#123').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += `#${i + 100} `;
  const r = extractVcsRefs(text);
  assert.ok((r.totals.issue || 0) <= 10);
});

test('counts totals by kind', () => {
  const r = extractVcsRefs('Fixed #123 in commit a1b2c3d in branch: foo');
  assert.ok(r.totals.issue >= 1);
  assert.ok(r.totals.commit >= 1);
  assert.ok(r.totals.branch >= 1);
});

test('rejects src/foo.js as repo ref', () => {
  const r = extractVcsRefs('See src/foo.js for impl.');
  assert.equal(r.refs.filter((rf) => rf.kind === 'repo').length, 0);
});

test('buildVcsRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: '#123' },
    { name: 'b.md', extractedText: 'commit abc1234' },
  ];
  const r = buildVcsRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderVcsRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'Fixed #123' }];
  const r = buildVcsRefsForFiles(files);
  const md = renderVcsRefsBlock(r);
  assert.match(md, /^## VERSION CONTROL REFERENCES/);
});

test('renderVcsRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderVcsRefsBlock({ perFile: [] }), '');
  assert.equal(renderVcsRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildVcsRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: '#123' },
  ]);
  assert.equal(r.perFile.length, 1);
});
