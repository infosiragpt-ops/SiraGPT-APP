'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOpenAICompatibleClient } = require('../src/services/agents/agent-task-runner');

/**
 * The agent runtime's OpenAI-compatible client must carry a bounded
 * per-request timeout + retry budget. The SDK defaults to a 600s (10 min)
 * timeout with 2 silent retries; a hung provider would otherwise freeze the
 * planning phase ("Analizando solicitud", 0 steps) for minutes while the
 * client's 90s idle watchdog aborts the run. These tests pin the bound in
 * place and keep it env-configurable.
 */

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const TARGET = { provider: 'OpenAI', apiKeyEnv: 'TEST_AGENT_LLM_KEY' };

test('client carries a bounded default timeout (not the 600s SDK default)', () => {
  const restore = rememberEnv(['TEST_AGENT_LLM_KEY', 'AGENT_TASK_LLM_TIMEOUT_MS', 'AGENT_TASK_LLM_MAX_RETRIES']);
  process.env.TEST_AGENT_LLM_KEY = 'sk-test';
  delete process.env.AGENT_TASK_LLM_TIMEOUT_MS;
  delete process.env.AGENT_TASK_LLM_MAX_RETRIES;
  try {
    const client = buildOpenAICompatibleClient(TARGET);
    assert.ok(client, 'client should be built when an API key is present');
    assert.equal(client.timeout, 60_000, 'default timeout should be 60s');
    assert.ok(client.timeout < 600_000, 'must be far below the 600s SDK default');
    assert.equal(client.maxRetries, 2);
  } finally {
    restore();
  }
});

test('timeout + retries are configurable via env', () => {
  const restore = rememberEnv(['TEST_AGENT_LLM_KEY', 'AGENT_TASK_LLM_TIMEOUT_MS', 'AGENT_TASK_LLM_MAX_RETRIES']);
  process.env.TEST_AGENT_LLM_KEY = 'sk-test';
  process.env.AGENT_TASK_LLM_TIMEOUT_MS = '25000';
  process.env.AGENT_TASK_LLM_MAX_RETRIES = '1';
  try {
    const client = buildOpenAICompatibleClient(TARGET);
    assert.equal(client.timeout, 25_000);
    assert.equal(client.maxRetries, 1);
  } finally {
    restore();
  }
});

test('invalid / non-positive env values fall back to the safe default timeout', () => {
  const restore = rememberEnv(['TEST_AGENT_LLM_KEY', 'AGENT_TASK_LLM_TIMEOUT_MS', 'AGENT_TASK_LLM_MAX_RETRIES']);
  process.env.TEST_AGENT_LLM_KEY = 'sk-test';
  process.env.AGENT_TASK_LLM_TIMEOUT_MS = 'not-a-number';
  process.env.AGENT_TASK_LLM_MAX_RETRIES = '-3';
  try {
    const client = buildOpenAICompatibleClient(TARGET);
    assert.equal(client.timeout, 60_000, 'garbage timeout env → default');
    assert.equal(client.maxRetries, 2, 'negative retries env → default');
  } finally {
    restore();
  }
});

test('no API key → null (unchanged behavior)', () => {
  const restore = rememberEnv(['TEST_AGENT_LLM_KEY']);
  delete process.env.TEST_AGENT_LLM_KEY;
  try {
    assert.equal(buildOpenAICompatibleClient(TARGET), null);
    assert.equal(buildOpenAICompatibleClient(null), null);
    assert.equal(buildOpenAICompatibleClient({ provider: 'x' }), null);
  } finally {
    restore();
  }
});
