'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTENSION_FAMILIES,
  listFamilies,
  listProviders,
  buildExtensionCatalogReport,
  recommendExtensionFamilies,
} = require('../src/services/agents/platform-extension-catalog');

test('extension catalog covers OpenClaw-style capability families without vendoring plugins', () => {
  const familyIds = new Set(EXTENSION_FAMILIES.map((family) => family.id));
  for (const expected of ['llm-providers', 'media-generation', 'search-retrieval', 'channels', 'memory-knowledge', 'speech-audio']) {
    assert.ok(familyIds.has(expected), `expected ${expected}`);
  }
  assert.ok(listFamilies().every((family) => family.providerCount > 0));
});

test('extension catalog includes core SiraGPT providers and channels', () => {
  const providers = new Set(listProviders().map((provider) => provider.id));
  for (const expected of ['openai', 'anthropic', 'google', 'fal', 'runway', 'telegram', 'whatsapp', 'redis', 'elevenlabs']) {
    assert.ok(providers.has(expected), `expected ${expected}`);
  }
});

test('extension catalog detects configured providers from env', () => {
  const report = buildExtensionCatalogReport({
    env: {
      OPENAI_API_KEY: 'test',
      FAL_API_KEY: 'test',
      TELEGRAM_BOT_TOKEN: 'test',
    },
  });
  const configured = new Set(report.providers.filter((provider) => provider.configured).map((provider) => provider.id));
  assert.ok(configured.has('openai'));
  assert.ok(configured.has('fal'));
  assert.ok(configured.has('telegram'));
});

test('extension recommendation routes video and channel requests', () => {
  const video = recommendExtensionFamilies('generar video con fal runway imagen');
  assert.equal(video[0].family, 'media-generation');

  const channels = recommendExtensionFamilies('conectar telegram whatsapp slack mensajes');
  assert.equal(channels[0].family, 'channels');
});
