'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-mime-types');
const { extractMimeTypes, buildMimeTypesForFiles, renderMimeTypesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractMimeTypes('').total, 0);
  assert.equal(extractMimeTypes(null).total, 0);
});

test('detects text/html', () => {
  const r = extractMimeTypes('Content-Type: text/html charset=utf-8');
  assert.ok(r.entries.some((e) => e.mime === 'text/html'));
});

test('detects application/json', () => {
  const r = extractMimeTypes('Returns application/json by default.');
  assert.ok(r.entries.some((e) => e.mime === 'application/json'));
});

test('detects image/png', () => {
  const r = extractMimeTypes('Accepts image/png and image/jpeg uploads.');
  assert.ok(r.entries.some((e) => e.mime === 'image/png'));
});

test('detects image/svg+xml', () => {
  const r = extractMimeTypes('SVG uses image/svg+xml MIME.');
  assert.ok(r.entries.some((e) => e.mime === 'image/svg+xml'));
});

test('detects multipart/form-data', () => {
  const r = extractMimeTypes('Upload as multipart/form-data');
  assert.ok(r.entries.some((e) => e.mime === 'multipart/form-data'));
});

test('detects video/mp4', () => {
  const r = extractMimeTypes('Streams video/mp4 reliably.');
  assert.ok(r.entries.some((e) => e.mime === 'video/mp4'));
});

test('detects audio/mpeg', () => {
  const r = extractMimeTypes('Podcast file audio/mpeg distributed.');
  assert.ok(r.entries.some((e) => e.mime === 'audio/mpeg'));
});

test('rejects "foo/bar" with unknown top-level', () => {
  const r = extractMimeTypes('Strange foo/bar value here.');
  assert.equal(r.entries.filter((e) => /foo\/bar/.test(e.mime)).length, 0);
});

test('groups by top-level', () => {
  const r = extractMimeTypes('text/plain application/json image/png audio/mpeg');
  assert.ok((r.totals.text || 0) >= 1);
  assert.ok((r.totals.application || 0) >= 1);
  assert.ok((r.totals.image || 0) >= 1);
  assert.ok((r.totals.audio || 0) >= 1);
});

test('dedupes identical MIME types', () => {
  const r = extractMimeTypes('text/html and again text/html');
  assert.equal(r.entries.filter((e) => e.mime === 'text/html').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 30; i++) text += `application/type${i} `;
  const r = extractMimeTypes(text);
  assert.ok(r.entries.length <= 20);
});

test('buildMimeTypesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: 'text/html' },
    { name: 'b.md', extractedText: 'application/json' },
  ];
  const r = buildMimeTypesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderMimeTypesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: 'text/html' }];
  const r = buildMimeTypesForFiles(files);
  const md = renderMimeTypesBlock(r);
  assert.match(md, /^## MIME TYPES/);
});

test('renderMimeTypesBlock empty when nothing surfaces', () => {
  assert.equal(renderMimeTypesBlock({ perFile: [] }), '');
  assert.equal(renderMimeTypesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildMimeTypesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'text/html' },
  ]);
  assert.equal(r.perFile.length, 1);
});
