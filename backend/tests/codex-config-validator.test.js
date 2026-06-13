'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateCodexConfig } = require('../src/services/codex/config-validator');

test('flag off → inert, ok, no warnings', () => {
  const r = validateCodexConfig({});
  assert.equal(r.enabled, false);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 0);
});

test('flag on without REDIS_URL warns about the worker/streaming', () => {
  const r = validateCodexConfig({ CODEX_AGENT_V2: '1', CEREBRAS_API_KEY: 'k' });
  assert.equal(r.enabled, true);
  assert.ok(r.warnings.some((w) => /REDIS_URL/.test(w)));
});

test('flag on without any LLM key warns the agent loop will fail', () => {
  const r = validateCodexConfig({ CODEX_AGENT_V2: '1', REDIS_URL: 'redis://x' });
  assert.ok(r.warnings.some((w) => /CEREBRAS_API_KEY or OPENROUTER_API_KEY/.test(w)));
});

test('a healthy config is ok with no warnings', () => {
  const r = validateCodexConfig({ CODEX_AGENT_V2: '1', REDIS_URL: 'redis://x', CEREBRAS_API_KEY: 'k', CODE_RUNNER_URL: 'http://runner:4097' });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 0);
});

test('an invalid CODE_RUNNER_URL is an error (ok=false)', () => {
  const r = validateCodexConfig({ CODEX_AGENT_V2: '1', REDIS_URL: 'redis://x', CEREBRAS_API_KEY: 'k', CODE_RUNNER_URL: 'not a url' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /CODE_RUNNER_URL/.test(e)));
});

test('out-of-range numeric envs warn', () => {
  const r = validateCodexConfig({ CODEX_AGENT_V2: '1', REDIS_URL: 'redis://x', CEREBRAS_API_KEY: 'k', CODEX_RUN_TIMEOUT_MS: '5000', CODEX_MAX_STEPS: '0', CODEX_COST_PROMO_MULTIPLIER: '2' });
  assert.ok(r.warnings.some((w) => /CODEX_RUN_TIMEOUT_MS/.test(w)));
  assert.ok(r.warnings.some((w) => /CODEX_MAX_STEPS/.test(w)));
  assert.ok(r.warnings.some((w) => /CODEX_COST_PROMO_MULTIPLIER/.test(w)));
});
