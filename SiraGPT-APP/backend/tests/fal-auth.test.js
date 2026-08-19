'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanEnvValue,
  decryptAdminConnectionKey,
  getFalApiKey,
  getFalApiKeySource,
  resolveFalApiKey,
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

test('decryptAdminConnectionKey accepts encrypted admin connection values', () => {
  const decryptFn = (value) => {
    assert.equal(value, 'ciphertext');
    return ' Key fal-admin-key ';
  };

  assert.equal(decryptAdminConnectionKey('enc:v1:ciphertext', decryptFn), 'fal-admin-key');
});

test('resolveFalApiKey prefers the enabled admin fal.ai connection over env aliases', async () => {
  const prisma = {
    adminConnection: {
      async findFirst(args) {
        assert.deepEqual(args.where, {
          providerKey: 'fal',
          enabled: true,
          apiKey: { not: null },
        });
        return { apiKey: 'enc:v1:stored' };
      },
    },
  };
  const resolved = await resolveFalApiKey({
    env: { FAL_KEY: 'env-key' },
    prisma,
    decryptFn: () => 'admin-key',
  });

  assert.deepEqual(resolved, { apiKey: 'admin-key', source: 'admin_connections:fal' });
});

test('resolveFalApiKey falls back to env when no admin fal.ai connection exists', async () => {
  const prisma = {
    adminConnection: {
      async findFirst() {
        return null;
      },
    },
  };
  const resolved = await resolveFalApiKey({
    env: { FAL_API_KEY: 'env-key' },
    prisma,
  });

  assert.deepEqual(resolved, { apiKey: 'env-key', source: 'FAL_API_KEY' });
});
