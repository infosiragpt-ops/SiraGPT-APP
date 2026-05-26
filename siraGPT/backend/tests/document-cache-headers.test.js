'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-cache-headers');
const { extractCacheHeaders, buildCacheHeadersForFiles, renderCacheHeadersBlock, _internal } = engine;
const { parseCacheControl } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractCacheHeaders('').total, 0);
  assert.equal(extractCacheHeaders(null).total, 0);
});

test('parseCacheControl: max-age + directives', () => {
  const r = parseCacheControl('public, max-age=3600, must-revalidate');
  assert.equal(r.maxAge, 3600);
  assert.ok(r.directives.includes('public'));
  assert.ok(r.directives.includes('must-revalidate'));
});

test('parseCacheControl: stale-while-revalidate', () => {
  const r = parseCacheControl('max-age=60, stale-while-revalidate=120');
  assert.equal(r.staleWhileRevalidate, 120);
});

test('detects Cache-Control header', () => {
  const r = extractCacheHeaders('Cache-Control: public, max-age=3600');
  const entry = r.entries.find((e) => e.header === 'Cache-Control');
  assert.ok(entry);
  assert.equal(entry.parsed.maxAge, 3600);
});

test('detects ETag strong', () => {
  const r = extractCacheHeaders('ETag: "abc123"');
  assert.ok(r.entries.some((e) => e.header === 'ETag' && !e.weak));
});

test('detects ETag weak (W/)', () => {
  const r = extractCacheHeaders('ETag: W/"abc123"');
  assert.ok(r.entries.some((e) => e.header === 'ETag' && e.weak));
});

test('detects Last-Modified', () => {
  const r = extractCacheHeaders('Last-Modified: Wed, 21 Oct 2025 07:28:00 GMT');
  assert.ok(r.entries.some((e) => e.header === 'Last-Modified'));
});

test('detects Expires', () => {
  const r = extractCacheHeaders('Expires: Thu, 01 Dec 2025 16:00:00 GMT');
  assert.ok(r.entries.some((e) => e.header === 'Expires'));
});

test('detects Pragma: no-cache', () => {
  const r = extractCacheHeaders('Pragma: no-cache');
  assert.ok(r.entries.some((e) => e.header === 'Pragma'));
});

test('detects Vary: Accept', () => {
  const r = extractCacheHeaders('Vary: Accept, Accept-Encoding');
  assert.ok(r.entries.some((e) => e.header === 'Vary'));
});

test('detects Age', () => {
  const r = extractCacheHeaders('Age: 1234');
  assert.ok(r.entries.some((e) => e.header === 'Age'));
});

test('dedupes identical Cache-Control values', () => {
  const r = extractCacheHeaders('Cache-Control: max-age=60\nCache-Control: max-age=60');
  assert.equal(r.entries.filter((e) => e.header === 'Cache-Control').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `Cache-Control: max-age=${i}\n`;
  const r = extractCacheHeaders(text);
  assert.ok(r.entries.length <= 18);
});

test('counts totals by header', () => {
  const r = extractCacheHeaders(
    'Cache-Control: public\nETag: "v1"\nLast-Modified: Wed, 21 Oct 2025 07:28:00 GMT'
  );
  assert.ok(r.totals.cacheControl >= 1);
  assert.ok(r.totals.etag >= 1);
  assert.ok(r.totals.lastModified >= 1);
});

test('buildCacheHeadersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'Cache-Control: max-age=60' },
    { name: 'b', extractedText: 'ETag: "v1"' },
  ];
  const r = buildCacheHeadersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCacheHeadersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'h', extractedText: 'Cache-Control: max-age=60' }];
  const r = buildCacheHeadersForFiles(files);
  const md = renderCacheHeadersBlock(r);
  assert.match(md, /^## HTTP CACHE/);
});

test('renderCacheHeadersBlock empty when nothing surfaces', () => {
  assert.equal(renderCacheHeadersBlock({ perFile: [] }), '');
  assert.equal(renderCacheHeadersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCacheHeadersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'Cache-Control: max-age=60' },
  ]);
  assert.equal(r.perFile.length, 1);
});
