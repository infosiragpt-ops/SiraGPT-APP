'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildOpenAICompatibleClient,
  normalizeAgentRuntimeModel,
  resolveAgentRuntimeClient,
} = require('../src/services/agents/agent-task-runner');

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

// ── runtime client fallback: never drive a client with a foreign model id ──
//
// Repro for the "Kimi K2.6 → Analizando solicitud → 90s stall" report: the
// selected model is OpenRouter-only, but OPENROUTER_API_KEY is empty (placeholder
// "" in the deployment .env). The runtime must fall back to a CONFIGURED provider
// AND a model that provider actually accepts — not carry "moonshotai/kimi-k2.6"
// into an OpenAI client (which 404s every call and stalls the run silently).

const RUNTIME_ENV_KEYS = [
  'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
  'AGENT_TASK_OPENAI_MODEL', 'AGENT_TASK_RUNTIME_MODEL',
];

test('Kimi/OpenRouter selection with empty OPENROUTER_API_KEY falls back to an OpenAI-valid model', () => {
  const restore = rememberEnv(RUNTIME_ENV_KEYS);
  process.env.OPENROUTER_API_KEY = '';                 // matches the prod .env placeholder ("")
  process.env.OPENAI_API_KEY = 'sk-test-openai-key';
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AGENT_TASK_OPENAI_MODEL;
  delete process.env.AGENT_TASK_RUNTIME_MODEL;
  try {
    const profile = normalizeAgentRuntimeModel('moonshotai/kimi-k2.6');
    assert.equal(profile.detected?.provider, 'OpenRouter', 'Kimi is detected as an OpenRouter model');
    const resolution = resolveAgentRuntimeClient(profile);
    assert.ok(resolution.client, 'a working client is resolved via the fallback list');
    assert.equal(resolution.provider, 'OpenAI', 'falls back to OpenAI when the OpenRouter key is empty');
    assert.notEqual(
      resolution.model, 'moonshotai/kimi-k2.6',
      'must NOT drive the OpenAI client with the foreign Kimi model id (the stall bug)',
    );
    assert.equal(resolution.model, 'gpt-4o-mini', 'uses a known OpenAI model the endpoint accepts');
  } finally {
    restore();
  }
});

test('OpenAI fallback model is env-tunable via AGENT_TASK_OPENAI_MODEL', () => {
  const restore = rememberEnv(RUNTIME_ENV_KEYS);
  process.env.OPENROUTER_API_KEY = '';
  process.env.OPENAI_API_KEY = 'sk-test-openai-key';
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_TASK_OPENAI_MODEL = 'gpt-4o';
  try {
    const resolution = resolveAgentRuntimeClient(normalizeAgentRuntimeModel('moonshotai/kimi-k2.6'));
    assert.equal(resolution.provider, 'OpenAI');
    assert.equal(resolution.model, 'gpt-4o');
  } finally {
    restore();
  }
});

test('a detected, configured provider is used directly (no fallback, model preserved)', () => {
  const restore = rememberEnv(RUNTIME_ENV_KEYS);
  process.env.OPENAI_API_KEY = 'sk-test-openai-key';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const resolution = resolveAgentRuntimeClient(normalizeAgentRuntimeModel('gpt-4o'));
    assert.equal(resolution.provider, 'OpenAI');
    assert.equal(resolution.model, 'gpt-4o', 'a native OpenAI selection keeps its own model id');
  } finally {
    restore();
  }
});

test('no provider key at all → null client (run degrades deterministically, never stalls on a foreign model)', () => {
  const restore = rememberEnv(RUNTIME_ENV_KEYS);
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const resolution = resolveAgentRuntimeClient(normalizeAgentRuntimeModel('moonshotai/kimi-k2.6'));
    assert.equal(resolution.client, null, 'no client when nothing is configured');
    assert.equal(resolution.provider, 'unconfigured');
  } finally {
    restore();
  }
});
