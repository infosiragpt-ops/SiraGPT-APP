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

test('Anthropic: Fable 5.x / Opus 5.5 / Opus 5 map every level to output_config.effort, never to disabled', () => {
  for (const model of ['claude-fable-5-1', 'claude-fable-5.1', 'anthropic/claude-opus-5.5', 'claude-opus-5']) {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => payloadFor('Anthropic', model, level).output_config?.effort);
    assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max'], model);
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const payload = payloadFor('Anthropic', model, level);
      assert.notEqual(payload.thinking?.type, 'disabled', `${model} ${level}`);
      assert.equal(payload.thinking?.budget_tokens, undefined);
      assert.equal(payload.reasoning_effort, undefined);
    }
    assert.deepEqual(payloadFor('Anthropic', model, 'high').thinking, { type: 'adaptive', display: 'summarized' });
  }
  // Trivial turn ("hola"): ai-service sends thinking disabled — re-resolved
  // to low effort because these models 400 on `disabled`.
  const trivial = buildProviderChatPayload({ provider: 'Anthropic', model: 'claude-fable-5-1', messages, stream: true,
    thinkingLevel: 'disabled', extra: { thinking: { type: 'disabled' } } }).payload;
  assert.equal(trivial.thinking, undefined);
  assert.deepEqual(trivial.output_config, { effort: 'low' });
  // Implicit default keeps the model's own depth but streams a summary.
  const implicit = payloadFor('Anthropic', 'claude-fable-5-1', 'high', false);
  assert.equal(implicit.output_config, undefined);
  assert.deepEqual(implicit.thinking, { type: 'adaptive', display: 'summarized' });
});

test('Anthropic: Opus/Sonnet 4.6–4.8 and Sonnet 5 use adaptive thinking + effort; Bajo answers directly', () => {
  assert.deepEqual(payloadFor('Anthropic', 'claude-opus-4-7', 'max').output_config, { effort: 'max' });
  assert.deepEqual(payloadFor('Anthropic', 'claude-opus-4-7', 'max').thinking, { type: 'adaptive', display: 'summarized' });
  const low = payloadFor('Anthropic', 'claude-opus-4-7', 'low');
  assert.equal(low.thinking, undefined, 'omitting thinking = no thinking on 4.x');
  assert.deepEqual(low.output_config, { effort: 'low' });
  assert.deepEqual(payloadFor('Anthropic', 'claude-sonnet-4-6', 'xhigh').output_config, { effort: 'high' }, '4.6 has no xhigh');
  assert.deepEqual(payloadFor('Anthropic', 'claude-sonnet-5', 'xhigh').output_config, { effort: 'xhigh' });
  const trivial = buildProviderChatPayload({ provider: 'Anthropic', model: 'claude-sonnet-5', messages, stream: true,
    thinkingLevel: 'disabled', extra: { thinking: { type: 'disabled' } } }).payload;
  assert.deepEqual(trivial.thinking, { type: 'disabled' });
});

test('Anthropic: Haiku 4.5 and older get budget_tokens thinking sized below max_tokens', () => {
  const budgets = ['medium', 'high', 'xhigh', 'max'].map((level) => payloadFor('Anthropic', 'claude-haiku-4-5', level).thinking?.budget_tokens);
  assert.deepEqual(budgets, [2048, 4096, 8192, 16384]);
  const max = buildProviderChatPayload({ provider: 'Anthropic', model: 'claude-haiku-4-5-20251001', messages, stream: true,
    thinkingLevel: 'max', thinkingLevelExplicit: true, maxOutputTokens: 4096 }).payload;
  assert.ok(max.max_tokens > max.thinking.budget_tokens, 'budget_tokens must stay below max_tokens');
  assert.ok(max.thinking.budget_tokens >= 1024);
  assert.equal(max.output_config, undefined, 'effort errors on Haiku 4.5');
  assert.deepEqual(payloadFor('Anthropic', 'claude-haiku-4-5', 'low').thinking, { type: 'disabled' });
  assert.equal(payloadFor('Anthropic', 'claude-3-5-sonnet', 'max').thinking, undefined, 'no thinking on 3.5');
});

test('OpenAI: reasoning_effort only on o-series / gpt-5.x reasoning models', () => {
  assert.equal(payloadFor('OpenAI', 'gpt-5.2', 'low').reasoning_effort, 'low');
  assert.equal(payloadFor('OpenAI', 'gpt-5', 'medium').reasoning_effort, 'medium');
  assert.equal(payloadFor('OpenAI', 'o4-mini', 'max').reasoning_effort, 'high');
  assert.equal(payloadFor('OpenAI', 'o3', 'xhigh').reasoning_effort, 'high');
  assert.equal(payloadFor('OpenAI', 'gpt-4o', 'high').reasoning_effort, undefined);
  assert.equal(payloadFor('OpenAI', 'gpt-5-chat-latest', 'high').reasoning_effort, undefined);
  assert.equal(payloadFor('OpenAI', 'o1-mini', 'high').reasoning_effort, undefined);
  assert.equal(payloadFor('OpenAI', 'gpt-5.2', 'high', false).reasoning_effort, undefined, 'implicit default untouched');
  assert.equal(payloadFor('OpenAI', 'gpt-5.2', 'high').thinking, undefined);
});

test('Anthropic streaming client forwards the resolved controls and retries once without them on a 400', async () => {
  const { createAnthropicStreamingClient } = require('../src/services/ai/first-party-chat-clients');
  const calls = [];
  const fakeSdk = {
    messages: {
      stream(body) {
        calls.push(body);
        const rejects = calls.length === 1;
        return {
          abort() {},
          async *[Symbol.asyncIterator]() {
            if (rejects) {
              throw Object.assign(new Error('output_config.effort: unsupported value'), { status: 400 });
            }
            yield { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pensando' } };
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hola' } };
          },
        };
      },
    },
  };
  const client = createAnthropicStreamingClient({ apiKey: 'test-key', sdkClient: fakeSdk });
  const stream = await client.chat.completions.create({
    model: 'claude-fable-5-1', stream: true, messages: [{ role: 'user', content: 'x' }],
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' },
  });
  const deltas = [];
  for await (const chunk of stream) deltas.push(chunk.choices[0].delta);
  assert.deepEqual(calls[0].output_config, { effort: 'max' });
  assert.deepEqual(calls[0].thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(calls[1].output_config, undefined, 'retry drops the rejected fields');
  assert.equal(calls[1].thinking, undefined);
  assert.deepEqual(deltas[0], { reasoning_content: 'pensando' }, 'thinking goes to the reasoning trace');
  assert.deepEqual(deltas[1], { content: 'hola' });
});
