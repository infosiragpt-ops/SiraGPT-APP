'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-container-registries');
const { extractContainerRegistries, buildContainerRegistriesForFiles, renderContainerRegistriesBlock, _internal } = engine;
const { isDigest, maskDigest } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractContainerRegistries('').total, 0);
  assert.equal(extractContainerRegistries(null).total, 0);
});

test('isDigest detects sha256', () => {
  assert.equal(isDigest('sha256:' + 'a'.repeat(64)), true);
  assert.equal(isDigest('latest'), false);
});

test('maskDigest masks long digests', () => {
  const masked = maskDigest('sha256:' + 'a'.repeat(64));
  assert.match(masked, /sha256:aaaaaa…aaaa/);
});

test('detects GCR image', () => {
  const r = extractContainerRegistries('Use gcr.io/myproject/myimage:v1.2.3');
  assert.ok(r.entries.some((e) => e.provider === 'gcr'));
});

test('detects GAR image', () => {
  const r = extractContainerRegistries('us-central1-docker.pkg.dev/proj/repo/myimage:tag');
  assert.ok(r.entries.some((e) => e.provider === 'gar'));
});

test('detects ECR image', () => {
  const r = extractContainerRegistries('123456789012.dkr.ecr.us-east-1.amazonaws.com/myimage:tag');
  assert.ok(r.entries.some((e) => e.provider === 'ecr'));
});

test('detects GHCR image', () => {
  const r = extractContainerRegistries('ghcr.io/myorg/myimage:1.0.0');
  assert.ok(r.entries.some((e) => e.provider === 'ghcr'));
});

test('detects Docker Hub explicit', () => {
  const r = extractContainerRegistries('docker.io/library/nginx:latest');
  assert.ok(r.entries.some((e) => e.provider === 'dockerHub'));
});

test('detects Quay image', () => {
  const r = extractContainerRegistries('quay.io/centos/centos:stream9');
  assert.ok(r.entries.some((e) => e.provider === 'quay'));
});

test('detects Azure Container Registry', () => {
  const r = extractContainerRegistries('myregistry.azurecr.io/myimage:tag');
  assert.ok(r.entries.some((e) => e.provider === 'acr'));
});

test('digest in image ref is masked', () => {
  const r = extractContainerRegistries('gcr.io/proj/img@sha256:' + 'a'.repeat(64));
  for (const e of r.entries) {
    assert.ok(!new RegExp('a'.repeat(64)).test(e.ref));
  }
});

test('dedupes identical refs', () => {
  const r = extractContainerRegistries('gcr.io/proj/img:tag and gcr.io/proj/img:tag');
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 1; i <= 20; i++) text += `gcr.io/proj-${i}/img:v${i} `;
  const r = extractContainerRegistries(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by provider', () => {
  const r = extractContainerRegistries(
    'gcr.io/proj/img:tag and ghcr.io/owner/img:1.0 and quay.io/org/img:latest'
  );
  assert.ok(r.totals.gcr >= 1);
  assert.ok(r.totals.ghcr >= 1);
  assert.ok(r.totals.quay >= 1);
});

test('buildContainerRegistriesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'gcr.io/proj/img:tag' },
    { name: 'b', extractedText: 'ghcr.io/owner/img:tag' },
  ];
  const r = buildContainerRegistriesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderContainerRegistriesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'k8s', extractedText: 'gcr.io/proj/img:tag' }];
  const r = buildContainerRegistriesForFiles(files);
  const md = renderContainerRegistriesBlock(r);
  assert.match(md, /^## CONTAINER REGISTRIES/);
});

test('renderContainerRegistriesBlock empty when nothing surfaces', () => {
  assert.equal(renderContainerRegistriesBlock({ perFile: [] }), '');
  assert.equal(renderContainerRegistriesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildContainerRegistriesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'gcr.io/proj/img:tag' },
  ]);
  assert.equal(r.perFile.length, 1);
});
