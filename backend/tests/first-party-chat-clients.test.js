'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripVendorPrefix,
  createAnthropicStreamingClient,
  createMoonshotClient,
  createXaiClient,
} = require('../src/services/ai/first-party-chat-clients');
const { CONNECTION_UNAVAILABLE_MESSAGE } = require('../src/services/ai/provider-inference');

test('stripVendorPrefix removes only the matching leading slug', () => {
  assert.equal(stripVendorPrefix('anthropic/claude-fable-5', ['anthropic/']), 'claude-fable-5');
  assert.equal(stripVendorPrefix('moonshotai/kimi-k2.6', ['moonshotai/']), 'kimi-k2.6');
  assert.equal(stripVendorPrefix('claude-sonnet-5', ['anthropic/']), 'claude-sonnet-5');
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
