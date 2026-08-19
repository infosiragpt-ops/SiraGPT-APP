'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-helm');
const { extractHelm, buildHelmForFiles, renderHelmBlock, _internal } = engine;
const { isHelmLike } = _internal;

const VALUES_FIXTURE = `image.repository: my-app
image.tag: v1.2.3
image.pullPolicy: IfNotPresent
replicaCount: 3
service.type: ClusterIP
service.port: 8080
ingress.enabled: true
ingress.className: nginx
persistence.enabled: false
serviceAccount.create: true
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi
autoscaling.minReplicas: 2
autoscaling.maxReplicas: 10
`;

const TEMPLATE_FIXTURE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "myapp.fullname" . }}
  labels:
    app: {{ .Values.image.repository }}
    release: {{ .Release.Name }}
    chart: {{ .Chart.Name }}-{{ .Chart.Version }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
      - name: app
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`;

const CHART_FIXTURE = `apiVersion: v2
name: my-app
version: 1.0.0
appVersion: "v1.2.3"
type: application
description: My awesome app
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractHelm('').total, 0);
  assert.equal(extractHelm(null).total, 0);
});

test('non-Helm text returns empty', () => {
  const r = extractHelm('Just regular text without Helm markers');
  assert.equal(r.total, 0);
});

test('isHelmLike heuristic', () => {
  assert.ok(isHelmLike('{{ .Values.x }}'));
  assert.ok(isHelmLike('apiVersion: v2\nname: x'));
  assert.ok(isHelmLike('image.repository: x'));
  assert.ok(!isHelmLike('plain text'));
});

test('detects image.repository / image.tag / image.pullPolicy', () => {
  const r = extractHelm(VALUES_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'image.repository' && e.detail === 'my-app'));
  assert.ok(r.entries.some((e) => e.name === 'image.tag' && e.detail === 'v1.2.3'));
  assert.ok(r.entries.some((e) => e.name === 'image.pullPolicy' && e.detail === 'IfNotPresent'));
});

test('detects replicaCount / service.type / service.port', () => {
  const r = extractHelm(VALUES_FIXTURE);
  assert.ok(r.entries.some((e) => e.name === 'replicaCount' && e.detail === '3'));
  assert.ok(r.entries.some((e) => e.name === 'service.type' && e.detail === 'ClusterIP'));
});

test('detects resource limits/requests', () => {
  const r = extractHelm(VALUES_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'cpu' && /m$/.test(e.detail)));
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'memory' && /Mi$/.test(e.detail)));
});

test('detects autoscaling fields', () => {
  const r = extractHelm(VALUES_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'autoscaling'));
});

test('detects .Values.X template references', () => {
  const r = extractHelm(TEMPLATE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'templateValues' && e.name === '.Values.image.repository'));
  assert.ok(r.entries.some((e) => e.kind === 'templateValues' && e.name === '.Values.replicaCount'));
});

test('detects .Chart.X references', () => {
  const r = extractHelm(TEMPLATE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'templateChart' && e.name === '.Chart.Name'));
  assert.ok(r.entries.some((e) => e.kind === 'templateChart' && e.name === '.Chart.Version'));
});

test('detects .Release.X references', () => {
  const r = extractHelm(TEMPLATE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'templateRelease' && e.name === '.Release.Name'));
});

test('detects include "X" template helpers', () => {
  const r = extractHelm(TEMPLATE_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'include' && e.name === 'myapp.fullname'));
});

test('detects Chart.yaml metadata', () => {
  const r = extractHelm(CHART_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'chartMeta' && e.name === 'name' && e.detail === 'my-app'));
  assert.ok(r.entries.some((e) => e.kind === 'chartMeta' && e.name === 'version'));
  assert.ok(r.entries.some((e) => e.kind === 'chartMeta' && e.name === 'appVersion'));
});

test('dedupes identical template references', () => {
  const r = extractHelm('{{ .Values.x }} and again {{ .Values.x }}');
  assert.equal(r.entries.filter((e) => e.name === '.Values.x').length, 1);
});

test('caps entries per file', () => {
  let text = 'apiVersion: v2\nname: x\n';
  for (let i = 0; i < 30; i++) text += `{{ .Values.field${i} }} `;
  const r = extractHelm(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractHelm(`${VALUES_FIXTURE}\n${TEMPLATE_FIXTURE}`);
  assert.ok(r.totals.valuesField >= 5);
  assert.ok(r.totals.templateValues >= 2);
});

test('buildHelmForFiles aggregates across batch', () => {
  const files = [
    { name: 'values.yaml', extractedText: VALUES_FIXTURE },
    { name: 'deployment.yaml', extractedText: TEMPLATE_FIXTURE },
  ];
  const r = buildHelmForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderHelmBlock returns markdown when entries exist', () => {
  const files = [{ name: 'Chart.yaml', extractedText: CHART_FIXTURE }];
  const r = buildHelmForFiles(files);
  const md = renderHelmBlock(r);
  assert.match(md, /^## HELM/);
});

test('renderHelmBlock empty when nothing surfaces', () => {
  assert.equal(renderHelmBlock({ perFile: [] }), '');
  assert.equal(renderHelmBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildHelmForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: VALUES_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
