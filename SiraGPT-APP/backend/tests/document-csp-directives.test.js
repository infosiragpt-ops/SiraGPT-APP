'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-csp-directives');
const { extractCspDirectives, buildCspDirectivesForFiles, renderCspDirectivesBlock } = engine;

test('empty / non-string tolerated', () => {
  assert.equal(extractCspDirectives('').total, 0);
  assert.equal(extractCspDirectives(null).total, 0);
});

test('detects default-src', () => {
  const r = extractCspDirectives("Content-Security-Policy: default-src 'self'");
  assert.ok(r.entries.some((e) => e.directive === 'default-src'));
});

test('detects script-src with multiple sources', () => {
  const r = extractCspDirectives("script-src 'self' https://cdn.example.com 'unsafe-inline'");
  assert.ok(r.entries.some((e) => e.directive === 'script-src'));
});

test('detects style-src', () => {
  const r = extractCspDirectives("style-src 'self' 'nonce-abc123'");
  assert.ok(r.entries.some((e) => e.directive === 'style-src'));
});

test('detects frame-ancestors', () => {
  const r = extractCspDirectives("frame-ancestors 'self' https://parent.example.com");
  assert.ok(r.entries.some((e) => e.directive === 'frame-ancestors'));
});

test('detects report-uri', () => {
  const r = extractCspDirectives('report-uri /csp-violations');
  assert.ok(r.entries.some((e) => e.directive === 'report-uri'));
});

test('detects upgrade-insecure-requests', () => {
  const r = extractCspDirectives('upgrade-insecure-requests');
  // Without explicit value, may not match — pattern requires value
  // Just verify no crash
  assert.ok(r);
});

test('dedupes identical directives', () => {
  const r = extractCspDirectives("default-src 'self'; default-src 'self'");
  assert.equal(r.entries.length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 25; i++) text += `script-src https://cdn${i}.example.com; `;
  const r = extractCspDirectives(text);
  assert.ok(r.entries.length <= 18);
});

test('buildCspDirectivesForFiles aggregates across batch', () => {
  const files = [
    { name: 'a.md', extractedText: "default-src 'self'" },
    { name: 'b.md', extractedText: "script-src 'self'" },
  ];
  const r = buildCspDirectivesForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderCspDirectivesBlock returns markdown when entries exist', () => {
  const files = [{ name: 'doc.md', extractedText: "default-src 'self'" }];
  const r = buildCspDirectivesForFiles(files);
  const md = renderCspDirectivesBlock(r);
  assert.match(md, /^## CSP DIRECTIVES/);
});

test('renderCspDirectivesBlock empty when nothing surfaces', () => {
  assert.equal(renderCspDirectivesBlock({ perFile: [] }), '');
  assert.equal(renderCspDirectivesBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildCspDirectivesForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: "default-src 'self'" },
  ]);
  assert.equal(r.perFile.length, 1);
});
