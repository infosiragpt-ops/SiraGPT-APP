/**
 * Extra coverage for agent-task-runner exported helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadAgentTaskRunnerHelpers } = require('./helpers/agent-task-runner-helpers');
const {
  classifyTaskError,
  computeRetryDelay,
  normalizeAgentRuntimeModel,
} = loadAgentTaskRunnerHelpers();

function withEnv(updates, fn) {
  const previous = {};
  for (const key of Object.keys(updates)) {
    previous[key] = process.env[key];
    if (updates[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = updates[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(updates)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test('classifyTaskError accepts string errors and detects connection failures', () => {
  const result = classifyTaskError('ECONNREFUSED connect 127.0.0.1');
  assert.equal(result.retryable, true);
  assert.equal(result.reason, 'network-timeout');
  assert.ok(result.ttlMs > 0);
});

test('classifyTaskError treats 403 permission errors as auth failures', () => {
  const err = new Error('Forbidden');
  err.statusCode = 403;
  const result = classifyTaskError(err);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, 'auth-failure');
});

test('classifyTaskError detects service unavailable from status code and message', () => {
  const byStatus = new Error('temporary upstream failure');
  byStatus.statusCode = 503;
  assert.equal(classifyTaskError(byStatus).reason, 'server-error');

  const byMessage = classifyTaskError(new Error('Service unavailable, retry later'));
  assert.equal(byMessage.retryable, true);
  assert.equal(byMessage.reason, 'server-error');
});

test('computeRetryDelay returns no-error classification for empty input', () => {
  const result = computeRetryDelay(null, 1);
  assert.equal(result.retry, false);
  assert.equal(result.reason, 'no-error');
});

test('normalizeAgentRuntimeModel defaults blank selected model to gpt-4o', () => {
  const result = withEnv({
    AGENT_TASK_OPENAI_MODEL: undefined,
    AGENT_TASK_RUNTIME_MODEL: undefined,
  }, () => normalizeAgentRuntimeModel('   '));

  assert.equal(result.displayModel, 'gpt-4o');
  assert.equal(result.runtimeModel, 'gpt-4o');
  assert.equal(result.runtimeProvider, 'selected-openai');
  assert.equal(result.remapped, false);
});

test('normalizeAgentRuntimeModel accepts OpenAI-compatible model prefixes', () => {
  for (const model of ['o3-mini', 'chatgpt-4o-latest', 'ft:gpt-4o:org:custom', 'ft:o4-mini:org:custom']) {
    const result = normalizeAgentRuntimeModel(` ${model} `);
    assert.equal(result.displayModel, model);
    assert.equal(result.runtimeModel, model);
    assert.equal(result.runtimeProvider, 'selected-openai');
    assert.equal(result.remapped, false);
  }
});

test('normalizeAgentRuntimeModel prefers AGENT_TASK_OPENAI_MODEL over runtime fallback env', () => {
  const result = withEnv({
    AGENT_TASK_OPENAI_MODEL: ' gpt-4.1 ',
    AGENT_TASK_RUNTIME_MODEL: 'gpt-4.1-nano',
  }, () => normalizeAgentRuntimeModel('claude-3-7-sonnet'));

  assert.equal(result.displayModel, 'claude-3-7-sonnet');
  assert.equal(result.runtimeModel, 'gpt-4.1');
  assert.equal(result.runtimeProvider, 'openai-fallback');
  assert.equal(result.remapped, true);
});
