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

test('classifyTaskError: null/undefined returns non-retryable', () => {
  assert.equal(classifyTaskError(null).retryable, false);
  assert.equal(classifyTaskError(undefined).retryable, false);
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
