'use strict';

// Unit tests for the Cerebras (Free IA) provider adapter.
//
// These tests stub the OpenAI constructor so we don't actually hit the
// network, and exercise the env-driven config resolution + descriptor
// shape that /api/ai/models depends on.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCerebrasConfig,
  isFreeIaConfigured,
  createCerebrasClient,
  buildFreeIaModelDescriptor,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_DISPLAY_NAME,
  PROVIDER_NAME,
} = require('../src/services/ai/cerebras-client');

test('getCerebrasConfig: returns disabled when no API key is set', () => {
  const cfg = getCerebrasConfig({ env: {} });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'no_api_key');
  // Defaults are still surfaced so the descriptor can render in the picker
  // (it just gets `enabled:false`).
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(cfg.displayName, DEFAULT_DISPLAY_NAME);
  assert.equal(cfg.provider, PROVIDER_NAME);
});

test('getCerebrasConfig: enabled with API key — uses defaults for base/model/name', () => {
  const cfg = getCerebrasConfig({ env: { CEREBRAS_API_KEY: 'csk-abc' } });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reason, 'ok');
  assert.equal(cfg.apiKey, 'csk-abc');
  assert.equal(cfg.baseURL, DEFAULT_BASE_URL);
  assert.equal(cfg.model, 'llama-3.1-8b');
  assert.equal(cfg.displayName, 'Free IA');
  assert.equal(cfg.provider, 'Cerebras');
});

test('getCerebrasConfig: overrides via env (CEREBRAS_BASE_URL, FREE_IA_MODEL_ID, FREE_IA_DISPLAY_NAME)', () => {
  const cfg = getCerebrasConfig({
    env: {
      CEREBRAS_API_KEY: 'csk-xyz',
      CEREBRAS_BASE_URL: 'https://example.test/v1/',
      FREE_IA_MODEL_ID: 'llama-3.1-70b',
      FREE_IA_DISPLAY_NAME: 'Gema4 31B',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseURL, 'https://example.test/v1');
  assert.equal(cfg.model, 'llama-3.1-70b');
  assert.equal(cfg.displayName, 'Gema4 31B');
});

test('getCerebrasConfig: invalid base URL is reported (enabled:false, reason:invalid_base_url)', () => {
  const cfg = getCerebrasConfig({
    env: { CEREBRAS_API_KEY: 'csk-abc', CEREBRAS_BASE_URL: 'not a url' },
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'invalid_base_url');
});

test('getCerebrasConfig: ignores blank/whitespace env values', () => {
  const cfg = getCerebrasConfig({
    env: {
      CEREBRAS_API_KEY: '   csk-trimmed   ',
      CEREBRAS_BASE_URL: '',
      FREE_IA_MODEL_ID: '   ',
    },
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, 'csk-trimmed');
  assert.equal(cfg.baseURL, DEFAULT_BASE_URL);
  assert.equal(cfg.model, DEFAULT_MODEL);
});

test('isFreeIaConfigured: matches enabled flag', () => {
  assert.equal(isFreeIaConfigured({ env: {} }), false);
  assert.equal(isFreeIaConfigured({ env: { CEREBRAS_API_KEY: 'csk-abc' } }), true);
});

test('createCerebrasClient: returns null when Cerebras is not configured', () => {
  const client = createCerebrasClient({ env: {} });
  assert.equal(client, null);
});

test('createCerebrasClient: instantiates OpenAI ctor with Cerebras apiKey + baseURL', () => {
  const calls = [];
  class FakeOpenAI {
    constructor(args) {
      calls.push(args);
      this.args = args;
    }
  }
  const client = createCerebrasClient({
    env: { CEREBRAS_API_KEY: 'csk-real-key' },
    OpenAICtor: FakeOpenAI,
  });
  assert.ok(client instanceof FakeOpenAI);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, 'csk-real-key');
  assert.equal(calls[0].baseURL, DEFAULT_BASE_URL);
});

test('buildFreeIaModelDescriptor: shape matches what /api/ai/models expects', () => {
  const desc = buildFreeIaModelDescriptor({ env: { CEREBRAS_API_KEY: 'csk-abc' } });
  assert.equal(desc.name, 'llama-3.1-8b');
  assert.equal(desc.displayName, 'Free IA');
  assert.equal(desc.provider, 'Cerebras');
  assert.equal(desc.type, 'TEXT');
  assert.equal(desc.virtual, true);
  assert.equal(desc.enabled, true);
  assert.match(desc.id, /^__virtual_/);
  assert.match(desc.id, /llama_3_1_8b/);
});

test('buildFreeIaModelDescriptor: enabled:false when Cerebras key missing — descriptor still well-formed', () => {
  const desc = buildFreeIaModelDescriptor({ env: {} });
  assert.equal(desc.enabled, false);
  assert.equal(desc.name, 'llama-3.1-8b');
  assert.equal(desc.provider, 'Cerebras');
});
