'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-container-refs');
const { extractContainerRefs, buildContainerRefsForFiles, renderContainerRefsBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractContainerRefs('').total, 0);
  assert.equal(extractContainerRefs(null).total, 0);
});

test('detects plain nginx:1.25', () => {
  const r = extractContainerRefs('FROM nginx:1.25-alpine');
  assert.ok(r.entries.some((e) => e.kind === 'plain'));
});

test('detects postgres:16', () => {
  const r = extractContainerRefs('image: postgres:16');
  assert.ok(r.entries.some((e) => e.kind === 'plain' && /postgres/.test(e.ref)));
});

test('detects gcr.io/project/image:tag', () => {
  const r = extractContainerRefs('image: gcr.io/my-project/web-frontend:v1.2.3');
  assert.ok(r.entries.some((e) => e.kind === 'registry'));
});

test('detects ghcr.io', () => {
  const r = extractContainerRefs('Pull ghcr.io/octocat/hello-world:latest');
  assert.ok(r.entries.some((e) => e.kind === 'registry'));
});

test('detects digest-pinned image', () => {
  const r = extractContainerRefs('Use nginx@sha256:abcdef123456789012345678901234');
  assert.ok(r.entries.some((e) => e.kind === 'digest'));
});

test('rejects bare image without tag', () => {
  const r = extractContainerRefs('Use nginx by itself');
  // Plain image:tag pattern requires colon + tag, so bare "nginx" shouldn't match plain
  assert.equal(r.entries.length, 0);
});

test('dedupes identical entries', () => {
  const r = extractContainerRefs('Pull nginx:1.25 and again nginx:1.25');
  assert.equal(r.entries.filter((e) => /nginx:1\.25/.test(e.ref)).length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `nginx:1.${i + 10} `;
  const r = extractContainerRefs(text);
  assert.ok(r.entries.length <= 20);
});

test('buildContainerRefsForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'nginx:1.25' },
    { name: 'b.md', extractedText: 'redis:7' },
  ];
  const r = buildContainerRefsForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderContainerRefsBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'nginx:1.25' }];
  const r = buildContainerRefsForFiles(files);
  const md = renderContainerRefsBlock(r);
  assert.match(md, /^## CONTAINER/);
});

test('renderContainerRefsBlock empty when nothing surfaces', () => {
  assert.equal(renderContainerRefsBlock({ perFile: [] }), '');
  assert.equal(renderContainerRefsBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildContainerRefsForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'nginx:1.25' },
  ]);
  assert.equal(r.perFile.length, 1);
});
