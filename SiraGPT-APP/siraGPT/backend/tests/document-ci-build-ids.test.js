'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-ci-build-ids');
const { extractCiBuildIds, buildCiBuildIdsForFiles, renderCiBuildIdsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCiBuildIds('').total, 0);
  assert.equal(extractCiBuildIds(null).total, 0);
});

test('detects GitHub Actions /actions/runs/N', () => {
  const r = extractCiBuildIds('https://github.com/org/repo/actions/runs/12345678');
  assert.ok(r.entries.some((e) => e.provider === 'gha' && e.id === '12345678'));
});

test('detects "workflow run #N"', () => {
  const r = extractCiBuildIds('GitHub Actions run #98765432 failed');
  assert.ok(r.entries.some((e) => e.provider === 'gha'));
});

test('detects Jenkins "build #N"', () => {
  const r = extractCiBuildIds('See jenkins build #1234 for logs');
  assert.ok(r.entries.some((e) => e.provider === 'jenkins'));
});

test('detects Jenkins /jobs/name/builds/N path', () => {
  const r = extractCiBuildIds('https://ci.example.com/jobs/my-pipeline/builds/42');
  assert.ok(r.entries.some((e) => e.provider === 'jenkins' && /my-pipeline\/42/.test(e.id)));
});

test('detects CircleCI workflow URL', () => {
  const r = extractCiBuildIds('https://circleci.com/workflow-runs/abcd1234-5678-90ab-cdef-1234567890ab');
  assert.ok(r.entries.some((e) => e.provider === 'circleci'));
});

test('detects GitLab "pipeline #N"', () => {
  const r = extractCiBuildIds('pipeline #234567 succeeded');
  assert.ok(r.entries.some((e) => e.provider === 'gitlab'));
});

test('detects GitLab /-/pipelines/N URL', () => {
  const r = extractCiBuildIds('https://gitlab.com/org/repo/-/pipelines/123456');
  assert.ok(r.entries.some((e) => e.provider === 'gitlab' && e.id === '123456'));
});

test('detects Buildkite URL', () => {
  const r = extractCiBuildIds('https://buildkite.com/my-org/my-pipeline/builds/789');
  assert.ok(r.entries.some((e) => e.provider === 'buildkite'));
});

test('detects Azure Pipelines build ID', () => {
  const r = extractCiBuildIds('Azure Pipelines build ID: 8765432');
  assert.ok(r.entries.some((e) => e.provider === 'azure'));
});

test('dedupes identical (provider, id) pairs', () => {
  const r = extractCiBuildIds('actions/runs/12345678 and actions/runs/12345678');
  assert.equal(r.entries.filter((e) => e.provider === 'gha' && e.id === '12345678').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `actions/runs/${1000000 + i} `;
  const r = extractCiBuildIds(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by provider', () => {
  const r = extractCiBuildIds(
    'actions/runs/12345678 and jenkins build #42 and pipeline #99999'
  );
  assert.ok(r.totals.gha >= 1);
  assert.ok(r.totals.jenkins >= 1);
  assert.ok(r.totals.gitlab >= 1);
});

test('buildCiBuildIdsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'actions/runs/12345678' },
    { name: 'b', extractedText: 'jenkins build #42' },
  ];
  const r = buildCiBuildIdsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCiBuildIdsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: 'actions/runs/12345678' }];
  const r = buildCiBuildIdsForFiles(files);
  const md = renderCiBuildIdsBlock(r);
  assert.match(md, /^## CI \/ CD BUILD/);
});

test('renderCiBuildIdsBlock empty when nothing surfaces', () => {
  assert.equal(renderCiBuildIdsBlock({ perFile: [] }), '');
  assert.equal(renderCiBuildIdsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCiBuildIdsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'actions/runs/12345678' },
  ]);
  assert.equal(r.perFile.length, 1);
});
