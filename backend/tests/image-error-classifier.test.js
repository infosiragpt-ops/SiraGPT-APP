'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { classifyImageGenError, MAX_MESSAGE_CHARS } = require('../src/services/image-error-classifier');

test('maps a 429 status to a clean image_quota_exceeded / HTTP 429', () => {
  const r = classifyImageGenError({ status: 429, message: 'whatever' });
  assert.equal(r.httpStatus, 429);
  assert.equal(r.code, 'image_quota_exceeded');
  assert.equal(r.isQuota, true);
  assert.match(r.message, /cuota/i);
});

test('detects Gemini RESOURCE_EXHAUSTED quota text even without a status', () => {
  const blob = '{"error":{"code":429,"message":"You exceeded your current quota ... RESOURCE_EXHAUSTED ...' + 'x'.repeat(4000) + '"}}';
  const r = classifyImageGenError(new Error(blob));
  assert.equal(r.httpStatus, 429);
  assert.equal(r.code, 'image_quota_exceeded');
  // Must NOT leak the multi-KB provider blob.
  assert.ok(r.message.length <= 220);
  assert.equal(r.message.includes('RESOURCE_EXHAUSTED'), false);
});

test('truncates a long non-quota error message (no raw-blob leak)', () => {
  const long = 'boom '.repeat(200); // ~1000 chars
  const r = classifyImageGenError(new Error(long));
  assert.equal(r.code, 'image_generation_failed');
  assert.equal(r.httpStatus, 500);
  assert.ok(r.message.length <= MAX_MESSAGE_CHARS + 1, `message too long: ${r.message.length}`);
});

test('preserves a 4xx provider status for non-quota client errors', () => {
  const r = classifyImageGenError({ status: 400, message: 'bad request' });
  assert.equal(r.httpStatus, 400);
  assert.equal(r.code, 'image_generation_failed');
});

test('defaults unknown errors to HTTP 500 with a short message', () => {
  const r = classifyImageGenError(new Error('unexpected'));
  assert.equal(r.httpStatus, 500);
  assert.equal(r.code, 'image_generation_failed');
  assert.equal(r.message, 'unexpected');
});
