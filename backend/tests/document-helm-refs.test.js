'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-helm-refs');
const { extractHelmRefs, buildHelmRefsForFiles, renderHelmRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractHelmRefs('').total, 0);
  assert.equal(extractHelmRefs(null).total, 0);
});

test('detects helm install command', () => {
  const r = extractHelmRefs('helm install redis bitnami/redis --version 18.5.0');
  assert.ok(r.entries.some((e) => e.kind === 'install'));
});

test('detects helm upgrade command', () => {
  const r = extractHelmRefs('helm upgrade my-app stable/nginx-ingress');
  assert.ok(r.entries.some((e) => e.kind === 'install'));
});

test('detects helm repo add', () => {
  const r = extractHelmRefs('helm repo add bitnami https://charts.bitnami.com/bitnami');
  assert.ok(r.entries.some((e) => e.kind === 'repoAdd'));
});

test('detects chart: field in YAML', () => {
  const r = extractHelmRefs('  chart: bitnami/postgresql');
  assert.ok(r.entries.some((e) => e.kind === 'chart'));
});

test('detects repoURL with charts domain', () => {
  const r = extractHelmRefs('repoURL: https://charts.bitnami.com/bitnami');
  assert.ok(r.entries.some((e) => e.kind === 'repoUrl'));
});

test('rejects repoURL without charts/helm domain', () => {
  const r = extractHelmRefs('repoURL: https://github.com/org/repo');
  assert.equal(r.entries.filter((e) => e.kind === 'repoUrl').length, 0);
});

test('detects Chart.yaml name + version pair', () => {
  const r = extractHelmRefs('apiVersion: v2\nname: my-chart\nversion: 1.2.3');
  assert.ok(r.entries.some((e) => e.kind === 'chartYaml' && /my-chart@1\.2\.3/.test(e.ref)));
});

test('extracts version from install command', () => {
  const r = extractHelmRefs('helm install redis bitnami/redis --version 18.5.0');
  const entry = r.entries.find((e) => e.kind === 'install');
  assert.ok(/18\.5\.0/.test(entry.ref));
});

test('dedupes identical commands', () => {
  const r = extractHelmRefs(
    'helm install redis bitnami/redis\nhelm install redis bitnami/redis'
  );
  assert.equal(r.entries.filter((e) => e.kind === 'install').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `helm install rel${i} bitnami/redis\n`;
  const r = extractHelmRefs(text);
  assert.ok(r.entries.length <= 16);
});

test('counts totals by kind', () => {
  const r = extractHelmRefs(
    'helm install redis bitnami/redis\nhelm repo add bitnami https://charts.bitnami.com/bitnami\nchart: bitnami/postgresql'
  );
  assert.ok(r.totals.install >= 1);
  assert.ok(r.totals.repoAdd >= 1);
  assert.ok(r.totals.chart >= 1);
});

test('buildHelmRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.sh', extractedText: 'helm install redis bitnami/redis' },
    { name: 'b.yml', extractedText: 'chart: bitnami/postgresql' },
  ];
  const r = buildHelmRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHelmRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'deploy.sh', extractedText: 'helm install redis bitnami/redis' }];
  const r = buildHelmRefsForFiles(files);
  const md = renderHelmRefsBlock(r);
  assert.match(md, /^## HELM/);
});

test('renderHelmRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderHelmRefsBlock({ perFile: [] }), '');
  assert.equal(renderHelmRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHelmRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'helm install redis bitnami/redis' },
  ]);
  assert.equal(r.perFile.length, 1);
});
