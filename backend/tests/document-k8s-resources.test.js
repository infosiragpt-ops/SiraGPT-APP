'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-k8s-resources');
const { extractK8sResources, buildK8sResourcesForFiles, renderK8sResourcesBlock, _internal } = engine;
const { isK8sLike } = _internal;

const K8S_FIXTURE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: production
  labels:
    app: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: app
        image: nginx:1.25.0
        ports:
        - containerPort: 80
        resources:
          limits:
            cpu: 500m
            memory: 512Mi
          requests:
            cpu: 100m
            memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: web-service
  namespace: production
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: web
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
spec:
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
`;

test('empty / non-string tolerated', () => {
  assert.equal(extractK8sResources('').total, 0);
  assert.equal(extractK8sResources(null).total, 0);
});

test('non-K8s text returns empty', () => {
  const r = extractK8sResources('Just regular text without k8s markers');
  assert.equal(r.total, 0);
});

test('isK8sLike heuristic', () => {
  assert.ok(isK8sLike('apiVersion: v1\nkind: Service'));
  assert.ok(!isK8sLike('apiVersion: v1')); // no kind
  assert.ok(!isK8sLike('plain text'));
});

test('detects apiVersion values', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'apiVersion' && e.name === 'apps/v1'));
  assert.ok(r.entries.some((e) => e.kind === 'apiVersion' && e.name === 'v1'));
  assert.ok(r.entries.some((e) => e.kind === 'apiVersion' && e.name === 'networking.k8s.io/v1'));
});

test('detects kind: Deployment / Service / Ingress', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.name === 'Deployment'));
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.name === 'Service'));
  assert.ok(r.entries.some((e) => e.kind === 'kind' && e.name === 'Ingress'));
});

test('skips invalid kind values', () => {
  const r = extractK8sResources('apiVersion: v1\nkind: NotARealKind\n');
  assert.ok(!r.entries.some((e) => e.kind === 'kind' && e.name === 'NotARealKind'));
});

test('detects metadata.name', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'name' && e.name === 'web-app'));
  assert.ok(r.entries.some((e) => e.kind === 'name' && e.name === 'web-service'));
});

test('detects metadata.namespace', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'namespace' && e.name === 'production'));
});

test('detects replicas count', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'replicas' && e.name === '3'));
});

test('detects container images', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'image' && /nginx:1\.25/.test(e.name)));
});

test('detects service type: LoadBalancer', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'serviceType' && e.name === 'LoadBalancer'));
});

test('detects port numbers', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'port' && e.name === '80'));
});

test('detects resource limits cpu/memory', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'cpu' && /m$/.test(e.detail)));
  assert.ok(r.entries.some((e) => e.kind === 'resource' && e.name === 'memory' && /Mi$/.test(e.detail)));
});

test('detects ingress hosts', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.entries.some((e) => e.kind === 'host' && e.name === 'api.example.com'));
});

test('dedupes identical kinds', () => {
  const r = extractK8sResources('apiVersion: v1\nkind: Service\n---\napiVersion: v1\nkind: Service');
  assert.equal(r.entries.filter((e) => e.kind === 'kind' && e.name === 'Service').length, 1);
});

test('caps entries per file', () => {
  let text = 'apiVersion: v1\nkind: Service\n';
  for (let i = 0; i < 30; i++) text += `  name: svc-${i}\n  namespace: ns-${i}\n`;
  const r = extractK8sResources(text);
  assert.ok(r.entries.length <= 24);
});

test('counts totals by kind', () => {
  const r = extractK8sResources(K8S_FIXTURE);
  assert.ok(r.totals.kind >= 3);
  assert.ok(r.totals.apiVersion >= 2);
  assert.ok(r.totals.name >= 2);
});

test('buildK8sResourcesForFiles aggregates across batch', () => {
  const files = [
    { name: 'deployment.yaml', extractedText: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a' },
    { name: 'service.yaml', extractedText: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: b' },
  ];
  const r = buildK8sResourcesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderK8sResourcesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'manifests.yaml', extractedText: K8S_FIXTURE }];
  const r = buildK8sResourcesForFiles(files);
  const md = renderK8sResourcesBlock(r);
  assert.match(md, /^## KUBERNETES/);
});

test('renderK8sResourcesBlock empty when nothing surfaces', () => {
  assert.equal(renderK8sResourcesBlock({ perFile: [] }), '');
  assert.equal(renderK8sResourcesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildK8sResourcesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: K8S_FIXTURE },
  ]);
  assert.equal(r.perFile.length, 1);
});
