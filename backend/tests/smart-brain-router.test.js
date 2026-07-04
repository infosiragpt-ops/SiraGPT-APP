'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBrainEscalation, DEFAULT_TARGET_MODEL } = require('../src/services/agents/smart-brain-router');

const BASE_ENV = { OPENROUTER_API_KEY: 'sk-or-test' };

test('prompted mode on a paid plan escalates to the OpenRouter target', () => {
  const out = resolveBrainEscalation({
    provider: 'Kimi', model: 'moonshot-v1-8k', toolCallMode: 'prompted',
    userPlan: 'PRO', env: BASE_ENV,
  });
  assert.ok(out);
  assert.equal(out.provider, 'OpenRouter');
  assert.equal(out.model, DEFAULT_TARGET_MODEL);
  assert.equal(out.reason, 'prompted_tool_mode');
});

test('weak free-tier model (native mode) also escalates', () => {
  const out = resolveBrainEscalation({
    provider: 'Cerebras', model: 'gpt-oss-120b', toolCallMode: 'native',
    userPlan: 'PRO_MAX', env: BASE_ENV,
  });
  assert.ok(out);
  assert.equal(out.reason, 'weak_model');
});

test('FREE plan is gated by default; superadmin bypasses the gate', () => {
  const base = { provider: 'Cerebras', model: 'gpt-oss-120b', toolCallMode: 'native', env: BASE_ENV };
  assert.equal(resolveBrainEscalation({ ...base, userPlan: 'FREE' }), null);
  assert.ok(resolveBrainEscalation({ ...base, userPlan: 'FREE', isSuperAdmin: true }));
});

test('SIRAGPT_SMART_BRAIN_PLANS=ALL opens the gate to FREE users', () => {
  const out = resolveBrainEscalation({
    provider: 'Cerebras', model: 'gpt-oss-120b', toolCallMode: 'native',
    userPlan: 'FREE', env: { ...BASE_ENV, SIRAGPT_SMART_BRAIN_PLANS: 'ALL' },
  });
  assert.ok(out);
});

test('strong models are never escalated', () => {
  for (const model of ['claude-sonnet-4-6', 'openai/gpt-5.5', 'gpt-4o-mini', 'anthropic/claude-sonnet-4.6', 'gemini-2.5-pro']) {
    assert.equal(
      resolveBrainEscalation({ provider: 'X', model, toolCallMode: 'prompted', userPlan: 'PRO', env: BASE_ENV }),
      null,
      `should not escalate ${model}`,
    );
  }
});

test('capable mid models in native mode stay untouched', () => {
  assert.equal(
    resolveBrainEscalation({ provider: 'Groq', model: 'llama-3.3-70b-versatile', toolCallMode: 'native', userPlan: 'PRO', env: BASE_ENV }),
    null,
  );
});

test('no OPENROUTER_API_KEY → never escalates', () => {
  assert.equal(
    resolveBrainEscalation({ provider: 'Kimi', model: 'moonshot-v1-8k', toolCallMode: 'prompted', userPlan: 'PRO', env: {} }),
    null,
  );
});

test('kill switch SIRAGPT_SMART_BRAIN=0', () => {
  assert.equal(
    resolveBrainEscalation({
      provider: 'Kimi', model: 'moonshot-v1-8k', toolCallMode: 'prompted', userPlan: 'PRO',
      env: { ...BASE_ENV, SIRAGPT_SMART_BRAIN: '0' },
    }),
    null,
  );
});

test('SIRAGPT_SMART_BRAIN_MODEL overrides the target slug', () => {
  const out = resolveBrainEscalation({
    provider: 'Kimi', model: 'moonshot-v1-8k', toolCallMode: 'prompted', userPlan: 'PRO',
    env: { ...BASE_ENV, SIRAGPT_SMART_BRAIN_MODEL: 'anthropic/claude-haiku-4.5' },
  });
  assert.equal(out.model, 'anthropic/claude-haiku-4.5');
});

test('custom weak-model regex via env', () => {
  const env = { ...BASE_ENV, SIRAGPT_SMART_BRAIN_WEAK_MODELS: '^mi-modelo-flojo' };
  assert.ok(resolveBrainEscalation({ provider: 'X', model: 'mi-modelo-flojo-v2', toolCallMode: 'native', userPlan: 'PRO', env }));
  assert.equal(resolveBrainEscalation({ provider: 'Cerebras', model: 'gpt-oss-120b', toolCallMode: 'native', userPlan: 'PRO', env }), null);
});
