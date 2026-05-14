'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-k8s-refs');
const { extractK8sRefs, buildK8sRefsForFiles, renderK8sRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractK8sRefs('').total, 0);
  assert.equal(extractK8sRefs(null).total, 0);
});

test('detects apiVersion: apps/v1', () => {
  const r = extractK8sRefs('apiVersion: apps/v1\nkind: Deployment');
  assert.ok(r.entries.some((e) => e.kind === 'apiVersion' && /apps\/v1/.test(e.value)));
});

test('detects kind: Deployment', () => {
  const r = extractK8sRefs('apiVersion: apps/v1\nkind: Deployment');
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.value === 'Deployment'));
});

test('detects kind: Service', () => {
  const r = extractK8sRefs('kind: Service');
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.value === 'Service'));
});

test('detects kind: ConfigMap', () => {
  const r = extractK8sRefs('kind: ConfigMap');
  assert.ok(r.entries.some((e) => e.kind === 'kind'));
});

test('detects namespace: production', () => {
  const r = extractK8sRefs('namespace: production');
  assert.ok(r.entries.some((e) => e.kind === 'namespace'));
});

test('detects kubectl apply', () => {
  const r = extractK8sRefs('Run kubectl apply -f deployment.yaml');
  assert.ok(r.entries.some((e) => e.kind === 'kubectl' && e.value === 'apply'));
});

test('detects kubectl rollout', () => {
  const r = extractK8sRefs('Use kubectl rollout restart');
  assert.ok(r.entries.some((e) => e.kind === 'kubectl' && e.value === 'rollout'));
});

test('rejects unknown kind', () => {
  const r = extractK8sRefs('kind: NotAKubernetesType');
  assert.equal(r.entries.filter((e) => e.kind === 'kind').length, 0);
});

test('detects CRD kind: Certificate', () => {
  const r = extractK8sRefs('kind: Certificate');
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.value === 'Certificate'));
});

test('dedupes identical entries', () => {
  const r = extractK8sRefs('kind: Service\nkind: Service');
  assert.equal(r.entries.filter((e) => e.kind === 'kind' && e.value === 'Service').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `kind: Service\nnamespace: ns${i}\n`;
  const r = extractK8sRefs(text);
  assert.ok(r.entries.length <= 20);
});

test('buildK8sRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.yaml', extractedText: 'kind: Deployment' },
    { name: 'b.yaml', extractedText: 'kind: Service' },
  ];
  const r = buildK8sRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderK8sRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.yaml', extractedText: 'kind: Deployment' }];
  const r = buildK8sRefsForFiles(files);
  const md = renderK8sRefsBlock(r);
  assert.match(md, /^## KUBERNETES MANIFEST REFS/);
});

test('renderK8sRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderK8sRefsBlock({ perFile: [] }), '');
  assert.equal(renderK8sRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildK8sRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'kind: Deployment' },
  ]);
  assert.equal(r.perFile.length, 1);
});
