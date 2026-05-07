/**
 * Tests for agent-task-runner's exported helper functions.
 * Does NOT invoke the full runAgentTaskJob (that requires OpenAI).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyTaskError, normalizeAgentRuntimeModel } = require('../src/services/agents/agent-task-runner');

test('classifyTaskError: rate-limit errors are retryable', () => {
  for (const msg of [
    'Rate limit exceeded, retry in 20s',
    'rate_limit_error: too many requests',
    '429 Too Many Requests',
  ]) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, true, `should be retryable: ${msg}`);
    assert.equal(result.reason, 'rate-limited', `reason should be rate-limited: ${msg}`);
    assert.ok(result.ttlMs > 0, `ttlMs should be positive: ${msg}`);
  }
});

test('classifyTaskError: timeout / network errors are retryable', () => {
  for (const msg of ['timeout of 60000ms exceeded', 'ETIMEDOUT', 'ECONNRESET', 'socket hang up']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, true, `should be retryable: ${msg}`);
    assert.equal(result.reason, 'network-timeout', `reason should be network-timeout: ${msg}`);
  }
});

test('classifyTaskError: 5xx server errors are retryable', () => {
  const err = new Error('Internal Server Error');
  err.statusCode = 502;
  const result = classifyTaskError(err);
  assert.equal(result.retryable, true);
  assert.equal(result.reason, 'server-error');
});

test('classifyTaskError: auth failures are NOT retryable', () => {
  for (const msg of ['Invalid API key', 'Authentication failed', 'OPENAI_API_KEY not configured']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'auth-failure', `reason should be auth-failure: ${msg}`);
  }
  const err401 = new Error('Unauthorized');
  err401.code = 401;
  const result = classifyTaskError(err401);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'auth-failure');
});

test('classifyTaskError: validation errors are NOT retryable', () => {
  for (const msg of ['Missing taskId', 'Invalid payload', 'taskId is required']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'validation-error', `reason should be validation-error: ${msg}`);
  }
});

test('classifyTaskError: unknown errors are retryable', () => {
  const result = classifyTaskError(new Error('something unexpected happened'));
  assert.equal(result.retryable, true);
  assert.equal(result.reason, 'unknown');
  assert.ok(result.ttlMs > 0);
});

test('classifyTaskError: aborted/cancelled errors are NOT retryable', () => {
  for (const msg of ['Tarea aborted by user', 'The operation was canceled']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'aborted', `reason should be aborted: ${msg}`);
  }
  const abortErr = new Error('boom');
  abortErr.name = 'AbortError';
  const result = classifyTaskError(abortErr);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'aborted');
});

test('classifyTaskError: quota / billing errors are NOT retryable', () => {
  for (const msg of [
    'You exceeded your current quota — insufficient_quota',
    'Quota exceeded for this organization',
    'Billing not enabled for this account',
  ]) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'quota-exhausted', `reason should be quota-exhausted: ${msg}`);
  }
  const err402 = new Error('payment'); err402.statusCode = 402;
  assert.equal(classifyTaskError(err402).reason, 'quota-exhausted');
});

test('classifyTaskError: context length errors are NOT retryable', () => {
  for (const msg of [
    'context_length_exceeded: prompt is 130000 tokens',
    'This model maximum context length is 128000',
    'Please reduce the length of the messages',
  ]) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'context-length', `reason should be context-length: ${msg}`);
  }
});

test('classifyTaskError: content policy refusals are NOT retryable', () => {
  for (const msg of ['flagged by content_policy filter', 'Response was flagged by safety filter']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'content-policy');
  }
});

test('classifyTaskError: DNS errors are retryable', () => {
  for (const msg of ['getaddrinfo ENOTFOUND api.openai.com', 'EAI_AGAIN dns lookup failed']) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, true, `should be retryable: ${msg}`);
    assert.equal(result.reason, 'dns-failure');
    assert.ok(result.ttlMs > 0);
  }
});

test('classifyTaskError: 408 / 504 gateway timeouts route to network-timeout', () => {
  const err = new Error('Gateway Timeout'); err.statusCode = 504;
  const r = classifyTaskError(err);
  assert.equal(r.retryable, true);
  assert.equal(r.reason, 'network-timeout');
});

test('classifyTaskError: ttlMs jitter stays within ±25% of base', () => {
  // Sample many results — average should be near base, all within band.
  const samples = Array.from({ length: 50 }, () => classifyTaskError(new Error('rate limit hit')).ttlMs);
  for (const t of samples) {
    assert.ok(t >= 11_000 && t <= 19_000, `jittered ttl out of band: ${t}`);
  }
});

test('classifyTaskError: null/undefined returns non-retryable', () => {
  assert.equal(classifyTaskError(null).retryable, false);
  assert.equal(classifyTaskError(undefined).retryable, false);
});

test('classifyTaskError: model-unavailable errors are NOT retryable', () => {
  for (const msg of [
    'The model `gpt-4-foo` does not exist',
    'model_not_found: unknown model id',
    'This model has been retired and decommissioned',
    'no such model: claude-2',
  ]) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, false, `should NOT be retryable: ${msg}`);
    assert.equal(result.reason, 'model-unavailable', `reason should be model-unavailable: ${msg}`);
  }
});

test('classifyTaskError: payload-too-large errors are NOT retryable', () => {
  const err413 = new Error('payload too large'); err413.statusCode = 413;
  assert.equal(classifyTaskError(err413).reason, 'payload-too-large');
  const err = new Error('Request Entity Too Large');
  assert.equal(classifyTaskError(err).reason, 'payload-too-large');
});

test('classifyTaskError: 501 not-implemented is NOT retryable', () => {
  const err = new Error('Not Implemented'); err.statusCode = 501;
  const r = classifyTaskError(err);
  assert.equal(r.retryable, false);
  assert.equal(r.reason, 'not-implemented');
});

test('classifyTaskError: SSL/TLS errors are retryable', () => {
  for (const msg of [
    'unable to verify the first certificate',
    'CERT_HAS_EXPIRED',
    'self signed certificate in certificate chain',
    'TLS handshake failure',
  ]) {
    const result = classifyTaskError(new Error(msg));
    assert.equal(result.retryable, true, `should be retryable: ${msg}`);
    assert.equal(result.reason, 'ssl-error', `reason should be ssl-error: ${msg}`);
    assert.ok(result.ttlMs > 0);
  }
});

test('normalizeAgentRuntimeModel: OpenAI models pass through', () => {
  const result = normalizeAgentRuntimeModel('gpt-4o');
  assert.equal(result.displayModel, 'gpt-4o');
  assert.equal(result.runtimeModel, 'gpt-4o');
  assert.equal(result.runtimeProvider, 'selected-openai');
  assert.equal(result.remapped, false);
});

test('normalizeAgentRuntimeModel: non-OpenAI models use fallback', () => {
  const result = normalizeAgentRuntimeModel('claude-sonnet-4');
  assert.equal(result.displayModel, 'claude-sonnet-4');
  assert.ok(result.runtimeModel.includes('gpt-4o-mini'));
  assert.equal(result.runtimeProvider, 'openai-fallback');
  assert.equal(result.remapped, true);
});

test('normalizeAgentRuntimeModel: respects AGENT_TASK_RUNTIME_MODEL env override', () => {
  process.env.AGENT_TASK_RUNTIME_MODEL = 'gpt-4.1-nano';
  const result = normalizeAgentRuntimeModel('claude-opus');
  assert.equal(result.runtimeModel, 'gpt-4.1-nano');
  delete process.env.AGENT_TASK_RUNTIME_MODEL;
});
