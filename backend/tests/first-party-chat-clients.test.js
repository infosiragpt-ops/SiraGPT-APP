'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripVendorPrefix,
  createAnthropicStreamingClient,
  createMoonshotClient,
  createXaiClient,
  anthropicSupportsThinkingToggle,
  applyAnthropicThinkingControls,
} = require('../src/services/ai/first-party-chat-clients');
const { CONNECTION_UNAVAILABLE_MESSAGE } = require('../src/services/ai/provider-inference');

test('stripVendorPrefix removes only the matching leading slug', () => {
  assert.equal(stripVendorPrefix('anthropic/claude-fable-5', ['anthropic/']), 'claude-fable-5');
  assert.equal(stripVendorPrefix('moonshotai/kimi-k2.6', ['moonshotai/']), 'kimi-k2.6');
  assert.equal(stripVendorPrefix('claude-sonnet-5', ['anthropic/']), 'claude-sonnet-5');
});

test('createXaiClient points at api.x.ai when the key is present', () => {
  const prev = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test-key';
  try {
    const client = createXaiClient();
    assert.equal(client.baseURL, 'https://api.x.ai/v1');
  } finally {
    if (prev === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prev;
  }
});

test('missing first-party keys throw Conexión no disponible', () => {
  const prev = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SIRA_ANTHROPIC_API_KEY: process.env.SIRA_ANTHROPIC_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIRA_ANTHROPIC_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.KIMI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    assert.throws(() => createAnthropicStreamingClient({ apiKey: '' }), (err) => {
      assert.equal(err.message, CONNECTION_UNAVAILABLE_MESSAGE);
      return true;
    });
    assert.throws(() => createMoonshotClient(), (err) => {
      assert.equal(err.message, CONNECTION_UNAVAILABLE_MESSAGE);
      return true;
    });
    assert.throws(() => createXaiClient(), (err) => {
      assert.equal(err.message, CONNECTION_UNAVAILABLE_MESSAGE);
      return true;
    });
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Anthropic thinking toggle covers Claude 4/5 and disables on trivial payloads', () => {
  assert.equal(anthropicSupportsThinkingToggle('claude-sonnet-5'), true);
  assert.equal(anthropicSupportsThinkingToggle('claude-fable-5'), true);
  assert.equal(anthropicSupportsThinkingToggle('claude-3-5-sonnet'), false);
  const body = { model: 'claude-sonnet-5' };
  applyAnthropicThinkingControls(body, { thinking: { type: 'disabled' } }, 'claude-sonnet-5');
  assert.deepEqual(body.thinking, { type: 'disabled' });
});
