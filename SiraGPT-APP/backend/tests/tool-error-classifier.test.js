'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyToolError } = require('../src/services/sira/tool-error-classifier');

// ─── Status-based classification ──────────────────────────────────

test('classifies HTTP 429 as rate_limit + retry_with_backoff', () => {
  const out = classifyToolError({ status: 429, message: 'Too many requests' });
  assert.equal(out.category, 'rate_limit');
  assert.equal(out.severity, 'transient');
  assert.equal(out.retryable, true);
  assert.equal(out.strategy, 'retry_with_backoff');
});

test('classifies HTTP 503 as upstream_5xx', () => {
  const out = classifyToolError({ status: 503 });
  assert.equal(out.category, 'upstream_5xx');
  assert.equal(out.severity, 'transient');
});

test('classifies HTTP 401 as auth + ask_user_for_input', () => {
  const out = classifyToolError({ status: 401, message: 'Unauthorized' });
  assert.equal(out.category, 'permission_denied');
  assert.equal(out.severity, 'user_fixable');
  assert.equal(out.strategy, 'ask_user_for_input');
  assert.equal(out.retryable, false);
});

test('classifies HTTP 402 as quota', () => {
  const out = classifyToolError({ status: 402 });
  assert.equal(out.category, 'quota');
});

test('classifies HTTP 404 as not_found', () => {
  const out = classifyToolError({ status: 404 });
  assert.equal(out.category, 'not_found');
});

test('classifies HTTP 409 as conflict', () => {
  const out = classifyToolError({ status: 409 });
  assert.equal(out.category, 'conflict');
});

test('classifies HTTP 422 as validation', () => {
  const out = classifyToolError({ status: 422, message: 'Invalid payload' });
  assert.equal(out.category, 'validation');
});

// ─── Node error code classification ───────────────────────────────

test('classifies ECONNRESET as network + transient', () => {
  const out = classifyToolError({ code: 'ECONNRESET', message: 'socket hang up' });
  assert.equal(out.category, 'network');
  assert.equal(out.severity, 'transient');
  assert.equal(out.retryable, true);
});

test('classifies ETIMEDOUT as network', () => {
  const out = classifyToolError({ code: 'ETIMEDOUT' });
  assert.equal(out.category, 'network');
});

// ─── Message-based fallback ────────────────────────────────────

test('classifies "rate limit exceeded" message as rate_limit', () => {
  const out = classifyToolError({ message: 'rate limit exceeded — try again later' });
  assert.equal(out.category, 'rate_limit');
});

test('classifies "timed out" message as timeout', () => {
  const out = classifyToolError({ message: 'request timed out after 30s' });
  assert.equal(out.category, 'timeout');
});

test('classifies "invalid API key" as auth', () => {
  const out = classifyToolError({ message: 'invalid api key provided' });
  assert.equal(out.category, 'auth');
});

test('classifies "insufficient credit" as quota', () => {
  const out = classifyToolError({ message: 'insufficient credit balance to perform this action' });
  assert.equal(out.category, 'quota');
});

// ─── Retry-After header ────────────────────────────────────────

test('reads Retry-After from headers (Map-like)', () => {
  const out = classifyToolError({
    status: 429,
    headers: new Map([['retry-after', '12']]),
  });
  assert.equal(out.retryAfterMs, 12000);
});

test('reads Retry-After from headers (object)', () => {
  const out = classifyToolError({
    status: 429,
    headers: { 'retry-after': '5' },
  });
  assert.equal(out.retryAfterMs, 5000);
});

test('reads retryAfterMs property directly', () => {
  const out = classifyToolError({
    status: 429,
    retryAfterMs: 8000,
  });
  assert.equal(out.retryAfterMs, 8000);
});

test('parses HTTP-date Retry-After format', () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const out = classifyToolError({
    status: 429,
    headers: { 'retry-after': future },
  });
  assert.ok(out.retryAfterMs >= 50_000);
  assert.ok(out.retryAfterMs <= 70_000);
});

// ─── Strategy decisions ────────────────────────────────────────

test('rate_limit with attempts<=1 → retry_with_backoff', () => {
  const out = classifyToolError({ status: 429 }, { attempts: 1 });
  assert.equal(out.strategy, 'retry_with_backoff');
});

test('rate_limit with attempts>1 and fallback model → retry_with_fallback_model', () => {
  const out = classifyToolError(
    { status: 429 },
    { attempts: 2, hasFallbackModel: true },
  );
  assert.equal(out.strategy, 'retry_with_fallback_model');
});

test('quota error with fallback model → switch model', () => {
  const out = classifyToolError(
    { status: 402, message: 'quota exhausted' },
    { hasFallbackModel: true },
  );
  assert.equal(out.strategy, 'retry_with_fallback_model');
});

test('quota error without fallback → escalate to operator', () => {
  const out = classifyToolError({ status: 402, message: 'quota exhausted' });
  assert.equal(out.strategy, 'escalate_to_operator');
});

test('validation error with fallback tool → retry_with_different_tool', () => {
  const out = classifyToolError(
    { status: 422, message: 'invalid payload' },
    { hasFallbackTool: true },
  );
  assert.equal(out.strategy, 'retry_with_different_tool');
});

test('validation error without fallback tool → ask_user_for_input', () => {
  const out = classifyToolError({ status: 422, message: 'invalid payload' });
  assert.equal(out.strategy, 'ask_user_for_input');
});

// ─── Retryability cap ────────────────────────────────────────

test('respects maxAttempts cap', () => {
  const out = classifyToolError(
    { status: 503 },
    { attempts: 5, maxAttempts: 3 },
  );
  assert.equal(out.retryable, false);
});

// ─── User-facing message ────────────────────────────────────

test('userMessage is Spanish and references the situation', () => {
  const out = classifyToolError({ status: 429 });
  assert.match(out.userMessage, /rate|limit|velocidad|reintentar/i);
});

test('userMessage falls back gracefully for unknown errors', () => {
  const out = classifyToolError({});
  assert.ok(typeof out.userMessage === 'string' && out.userMessage.length > 0);
});

// ─── Resilience ─────────────────────────────────────────────

test('classifies null gracefully', () => {
  const out = classifyToolError(null);
  assert.equal(out.category, 'unknown');
  assert.equal(out.severity, 'system');
});

test('classifies an Error instance', () => {
  const err = new Error('timed out after 30s');
  const out = classifyToolError(err);
  assert.equal(out.category, 'timeout');
});

test('classifies a plain string', () => {
  const out = classifyToolError('rate limit exceeded');
  assert.equal(out.category, 'rate_limit');
});

test('telemetry block carries code/status/toolName/attempts', () => {
  const out = classifyToolError(
    { code: 'ECONNRESET', status: 502, message: 'socket' },
    { toolName: 'web_search', attempts: 2 },
  );
  assert.equal(out.telemetry.code, 'ECONNRESET');
  assert.equal(out.telemetry.status, 502);
  assert.equal(out.telemetry.toolName, 'web_search');
  assert.equal(out.telemetry.attempts, 2);
});

test('tool_internal fallback when only toolName context is set and we cannot classify', () => {
  const out = classifyToolError(
    { /* no recognisable fields */ },
    { toolName: 'invocable_x' },
  );
  assert.equal(out.category, 'tool_internal');
});

test('uses Response-like status property', () => {
  const responseLike = { status: 500, statusCode: undefined };
  const out = classifyToolError(responseLike);
  assert.equal(out.category, 'upstream_5xx');
});

test('uses err.cause.code when top-level code is missing', () => {
  const err = new Error('upstream broke');
  err.cause = { code: 'ECONNREFUSED' };
  const out = classifyToolError(err);
  assert.equal(out.category, 'network');
});
