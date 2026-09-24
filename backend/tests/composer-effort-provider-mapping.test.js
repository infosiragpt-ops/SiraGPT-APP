'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const orch = require('../src/services/reasoning-orchestrator');
const { buildProviderChatPayload } = require('../src/services/ai-product-os/litellm-gateway');

const messages = [{ role: 'user', content: 'Analiza este contrato' }];
const payloadFor = (provider, model, thinkingLevel, thinkingLevelExplicit = true) =>
  buildProviderChatPayload({ provider, model, messages, stream: true, thinkingLevel, thinkingLevelExplicit }).payload;

test('the five composer levels normalize to distinct compute tiers', () => {
  assert.deepEqual(
    ['Bajo', 'Medio', 'Alto', 'Extra', 'Max'].map((level) => orch.normalizeEffortLevel(level)),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(
    ['Bajo', 'Medio', 'Alto', 'Extra', 'Max'].map((level) => orch.thinkingLevelForEffort(level)),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(orch.thinkingLevelForEffort('nope'), null);
  assert.equal(orch.computeForEffort('Max').mode, 'self_consistency');
  assert.equal(orch.computeForEffort('Extra').samples, 1, 'Extra deepens thinking without 3× sampling');
});

test('Meta Muse Spark always carries reasoning_effort, following the level', () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => payloadFor('Meta', 'muse-spark-1.2', level).reasoning_effort);
  assert.deepEqual(levels, ['low', 'medium', 'high', 'xhigh', 'xhigh']);
});

test('DeepSeek V4: Bajo answers without thinking, Extra/Máx think at max', () => {
  const low = payloadFor('DeepSeek', 'deepseek-v4-pro', 'low');
  assert.deepEqual(low.thinking, { type: 'disabled' });
  assert.equal(low.reasoning_effort, undefined);
  assert.equal(payloadFor('DeepSeek', 'deepseek-v4-pro', 'high').reasoning_effort, 'high');
  assert.equal(payloadFor('DeepSeek', 'deepseek-v4-flash', 'xhigh').reasoning_effort, 'max');
  // The implicit global default keeps its old behaviour (thinking on).
  assert.deepEqual(payloadFor('DeepSeek', 'deepseek-v4-pro', 'low', false).thinking, { type: 'enabled' });
});

test('OpenRouter honours an explicit high, the implicit default stays medium', () => {
  assert.deepEqual(payloadFor('OpenRouter', 'x-ai/grok-4.20', 'high').reasoning, { effort: 'high' });
  assert.deepEqual(payloadFor('OpenRouter', 'x-ai/grok-4.20', 'medium').reasoning, { effort: 'medium' });
  assert.deepEqual(payloadFor('OpenRouter', 'x-ai/grok-4.20', 'high', false).reasoning, { effort: 'medium' });
});

test('xAI and Gemini get reasoning_effort only on supported models and explicit choices', () => {
  assert.equal(payloadFor('xAI', 'grok-3-mini', 'xhigh').reasoning_effort, 'high');
  assert.equal(payloadFor('xAI', 'grok-3-mini', 'medium').reasoning_effort, 'low');
  assert.equal(payloadFor('xAI', 'grok-4', 'high').reasoning_effort, undefined, 'grok-4 rejects the param');
  assert.equal(payloadFor('Gemini', 'gemini-2.5-pro', 'max').reasoning_effort, 'high');
  assert.equal(payloadFor('Gemini', 'gemini-2.5-flash', 'low').reasoning_effort, 'low');
  assert.equal(payloadFor('Gemini', 'gemini-2.5-pro', 'high', false).reasoning_effort, undefined);
  assert.equal(payloadFor('Gemini', 'gemini-1.5-pro', 'high').reasoning_effort, undefined);
});

test('providers without a native knob never receive one', () => {
  const anthropic = payloadFor('Anthropic', 'claude-opus-4-7', 'max');
  assert.equal(anthropic.reasoning_effort, undefined);
  assert.equal(anthropic.thinking, undefined);
  assert.equal(payloadFor('OpenAI', 'gpt-4o', 'high').reasoning_effort, undefined);
});
