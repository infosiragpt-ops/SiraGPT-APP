'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanEnvValue,
  getFalApiKey,
  getFalApiKeySource,
} = require('../src/services/fal/fal-auth');

test('cleanEnvValue strips accidental auth scheme prefixes', () => {
  assert.equal(cleanEnvValue(' Key abc:def '), 'abc:def');
  assert.equal(cleanEnvValue('"Bearer fal-secret"'), 'fal-secret');
});

test('getFalApiKey prefers split fal key id/secret when both are present', () => {
  const env = {
    FAL_KEY_ID: 'id_123',
    FAL_KEY_SECRET: 'secret_456',
    FAL_KEY: 'single-key',
  };

  assert.equal(getFalApiKey(env), 'id_123:secret_456');
  assert.equal(getFalApiKeySource(env), 'FAL_KEY_ID/FAL_KEY_SECRET');
});

test('getFalApiKey accepts deployed alias names without exposing values', () => {
  assert.equal(getFalApiKey({ FAL_AI_API_KEY: 'fal-ai-key' }), 'fal-ai-key');
  assert.equal(getFalApiKey({ FALAI_API_KEY: 'falai-key' }), 'falai-key');
  assert.equal(getFalApiKey({ TAL_AI_API_KEY: 'legacy-key' }), 'legacy-key');
  assert.equal(getFalApiKeySource({ FAL_API_KEY: 'fallback' }), 'FAL_API_KEY');
});

test('getFalApiKey returns empty string when no usable env is present', () => {
  assert.equal(getFalApiKey({ FAL_KEY: '   ', FAL_KEY_ID: 'id-only' }), '');
  assert.equal(getFalApiKeySource({}), null);
});
