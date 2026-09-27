const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProviderChatPayload,
} = require('../src/services/ai-product-os/litellm-gateway');

test('provider chat payload preserves temperature in provider payload', () => {
  const built = buildProviderChatPayload({
    provider: 'DeepSeek',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hola' }],
    stream: true,
    extra: { temperature: 0.55 },
  });

  assert.equal(built.payload.temperature, 0.55);
  assert.equal(built.payload.stream, true);
});

test('selected GPT-6 Sol uses its direct API without unsupported temperature', () => {
  for (const stream of [true, false]) {
    const built = buildProviderChatPayload({
      provider: 'OpenAI',
      model: 'gpt-6-sol',
      messages: [{ role: 'user', content: 'hola' }],
      stream,
      extra: { temperature: 0.55 },
    });

    assert.equal(built.provider, 'openai');
    assert.equal(built.payload.model, 'gpt-6-sol');
    assert.equal(built.payload.stream, stream);
    assert.equal('temperature' in built.payload, false);
  }
});

test('temperature remains available to models and transports that accept it', () => {
  const otherOpenAi = buildProviderChatPayload({
    provider: 'OpenAI', model: 'gpt-4o', extra: { temperature: 0.55 },
  });
  const openRouter = buildProviderChatPayload({
    provider: 'OpenRouter', model: 'openai/gpt-6-sol', extra: { temperature: 0.55 },
  });

  assert.equal(otherOpenAi.payload.temperature, 0.55);
  assert.equal(openRouter.payload.temperature, 0.55);
});
