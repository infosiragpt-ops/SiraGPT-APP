'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-versions');
const { extractVersions, buildVersionsForFiles, renderVersionsBlock, _internal } = engine;
const { isLikelySemver, normaliseVersion } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractVersions('').total, 0);
  assert.equal(extractVersions(null).total, 0);
});

test('isLikelySemver: valid forms', () => {
  assert.equal(isLikelySemver('1.2.3'), true);
  assert.equal(isLikelySemver('v1.2.3'), true);
  assert.equal(isLikelySemver('1.2.3-rc.1'), true);
  assert.equal(isLikelySemver('1.2.3+build.42'), true);
  assert.equal(isLikelySemver('1.2'), false);
  assert.equal(isLikelySemver('abc'), false);
});

test('normaliseVersion: strips leading v', () => {
  assert.equal(normaliseVersion('v1.2.3'), '1.2.3');
  assert.equal(normaliseVersion('1.2.3'), '1.2.3');
});

test('detects SemVer', () => {
  const r = extractVersions('Released 1.2.3 today.');
  assert.ok(r.versions.some((v) => v.kind === 'semver' && v.value === '1.2.3'));
});

test('detects v-prefixed SemVer', () => {
  const r = extractVersions('Released v2.0.0 today.');
  assert.ok(r.versions.some((v) => v.kind === 'semver' && v.value === 'v2.0.0'));
});

test('detects pre-release SemVer', () => {
  const r = extractVersions('Pre-release: 1.0.0-rc.1');
  assert.ok(r.versions.some((v) => /rc/.test(v.value)));
});

test('detects build-metadata SemVer', () => {
  const r = extractVersions('Build 1.0.0+sha.abc');
  assert.ok(r.versions.some((v) => /\+/.test(v.value)));
});

test('detects "Version: 1.2.3" labeled line', () => {
  const r = extractVersions('Version: 1.2.3\nSome content.');
  assert.ok(r.versions.some((v) => v.kind === 'labeled'));
});

test('detects Spanish "Versión: 1.2.3"', () => {
  const r = extractVersions('Versión: 2.0.0');
  assert.ok(r.versions.some((v) => v.kind === 'labeled'));
});

test('detects release header with date', () => {
  const r = extractVersions('## Release 1.2.3 (2024-03-15)');
  assert.ok(r.versions.some((v) => v.kind === 'release' && v.date && /2024-03-15/.test(v.date)));
});

test('detects CalVer', () => {
  const r = extractVersions('Build 2024.03.15 just rolled out.');
  assert.ok(r.versions.some((v) => v.kind === 'calver'));
});

test('dedupes identical versions within same kind', () => {
  const r = extractVersions('Release 1.0.0 and Release 1.0.0 again.');
  assert.equal(r.versions.filter((v) => v.value === '1.0.0' && v.kind === 'release').length, 1);
});

test('caps per kind', () => {
  let text = '';
  for (let i = 0; i < 15; i++) text += `v${i}.0.0 `;
  const r = extractVersions(text);
  assert.ok(r.totals.semver <= 8);
});

test('totals reports breakdown', () => {
  const r = extractVersions('Version: 1.0.0\n## Release 2.0.0 (2024-01-01)\nBuilt 2024.03.15');
  assert.ok(r.totals.labeled >= 1);
  assert.ok(r.totals.calver >= 1);
});

test('buildVersionsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'Version: 1.0.0' },
    { name: 'b.md', extractedText: 'v2.0.0 released' },
  ];
  const r = buildVersionsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderVersionsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'v1.2.3 released' }];
  const r = buildVersionsForFiles(files);
  const md = renderVersionsBlock(r);
  assert.match(md, /^## VERSIONS \/ RELEASES/);
});

test('renderVersionsBlock empty when nothing surfaces', () => {
  assert.equal(renderVersionsBlock({ perFile: [] }), '');
  assert.equal(renderVersionsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildVersionsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'v1.0.0' },
  ]);
  assert.equal(r.perFile.length, 1);
});

test('rejects too-short version like "1.2"', () => {
  const r = extractVersions('Section 1.2 has details.');
  assert.equal(r.versions.filter((v) => v.value === '1.2').length, 0);
});
