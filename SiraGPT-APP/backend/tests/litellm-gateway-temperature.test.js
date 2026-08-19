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
