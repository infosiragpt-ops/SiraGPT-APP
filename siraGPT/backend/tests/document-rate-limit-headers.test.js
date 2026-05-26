'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/services/document-rate-limit-headers');
const { extractRateLimitHeaders, buildRateLimitHeadersForFiles, renderRateLimitHeadersBlock, _internal } = engine;
const { classifyResetUnit } = _internal;

test('empty / non-string tolerated', () => {
  assert.equal(extractRateLimitHeaders('').total, 0);
  assert.equal(extractRateLimitHeaders(null).total, 0);
});

test('classifyResetUnit: seconds vs epoch', () => {
  assert.equal(classifyResetUnit('60'), 'seconds');
  assert.equal(classifyResetUnit('1577836800'), 'epoch');
});

test('detects X-RateLimit-Limit', () => {
  const r = extractRateLimitHeaders('X-RateLimit-Limit: 1000');
  assert.ok(r.entries.some((e) => e.kind === 'limit'));
});

test('detects X-RateLimit-Remaining', () => {
  const r = extractRateLimitHeaders('X-RateLimit-Remaining: 873');
  assert.ok(r.entries.some((e) => e.kind === 'remaining'));
});

test('detects X-RateLimit-Reset with epoch', () => {
  const r = extractRateLimitHeaders('X-RateLimit-Reset: 1577836800');
  const entry = r.entries.find((e) => e.kind === 'reset');
  assert.ok(entry);
  assert.equal(entry.unit, 'epoch');
});

test('detects X-RateLimit-Reset with seconds', () => {
  const r = extractRateLimitHeaders('X-RateLimit-Reset: 60');
  const entry = r.entries.find((e) => e.kind === 'reset');
  assert.ok(entry);
  assert.equal(entry.unit, 'seconds');
});

test('detects Retry-After in seconds', () => {
  const r = extractRateLimitHeaders('Retry-After: 120');
  assert.ok(r.entries.some((e) => e.kind === 'retryAfter'));
});

test('detects Retry-After HTTP date', () => {
  const r = extractRateLimitHeaders('Retry-After: Wed, 21 Oct 2025 07:28:00 GMT');
  assert.ok(r.entries.some((e) => e.kind === 'retryAfter'));
});

test('detects RFC 8030 RateLimit header', () => {
  const r = extractRateLimitHeaders('RateLimit: limit=100, remaining=50, reset=60');
  assert.ok(r.entries.some((e) => e.kind === 'rfc'));
});

test('detects Ratelimit-Policy', () => {
  const r = extractRateLimitHeaders('Ratelimit-Policy: "100;w=60"');
  assert.ok(r.entries.some((e) => e.kind === 'policy'));
});

test('dedupes identical entries', () => {
  const r = extractRateLimitHeaders('X-RateLimit-Limit: 1000\nX-RateLimit-Limit: 1000');
  assert.equal(r.entries.filter((e) => e.kind === 'limit').length, 1);
});

test('caps entries per file', () => {
  let text = '';
  for (let i = 0; i < 20; i++) text += `X-RateLimit-Limit: ${100 + i}\n`;
  const r = extractRateLimitHeaders(text);
  assert.ok(r.entries.length <= 14);
});

test('counts totals by kind', () => {
  const r = extractRateLimitHeaders(
    'X-RateLimit-Limit: 1000\nX-RateLimit-Remaining: 873\nRetry-After: 120'
  );
  assert.ok(r.totals.limit >= 1);
  assert.ok(r.totals.remaining >= 1);
  assert.ok(r.totals.retryAfter >= 1);
});

test('buildRateLimitHeadersForFiles aggregates across batch', () => {
  const files = [
    { name: 'a', extractedText: 'X-RateLimit-Limit: 1000' },
    { name: 'b', extractedText: 'Retry-After: 120' },
  ];
  const r = buildRateLimitHeadersForFiles(files);
  assert.equal(r.perFile.length, 2);
});

test('renderRateLimitHeadersBlock returns markdown when entries exist', () => {
  const files = [{ name: 'log', extractedText: 'X-RateLimit-Limit: 1000' }];
  const r = buildRateLimitHeadersForFiles(files);
  const md = renderRateLimitHeadersBlock(r);
  assert.match(md, /^## RATE-LIMIT/);
});

test('renderRateLimitHeadersBlock empty when nothing surfaces', () => {
  assert.equal(renderRateLimitHeadersBlock({ perFile: [] }), '');
  assert.equal(renderRateLimitHeadersBlock(null), '');
});

test('handles non-string extractedText', () => {
  const r = buildRateLimitHeadersForFiles([
    { name: 'a', extractedText: null },
    { name: 'b', extractedText: 'X-RateLimit-Limit: 1000' },
  ]);
  assert.equal(r.perFile.length, 1);
});
