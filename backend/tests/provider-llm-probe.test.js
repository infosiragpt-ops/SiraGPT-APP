'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLlmProviderProbe,
  createConfiguredLlmProbes,
  PROVIDERS,
} = require('../src/health/probes/provider-llm');
const { createHealthSystem } = require('../src/health/mount');

function fakeFetch(status = 200) {
  return async () => ({ status });
}

test('createLlmProviderProbe rejects missing name or baseUrl', () => {
  assert.throws(() => createLlmProviderProbe({ baseUrl: 'https://x' }), /name/);
  assert.throws(() => createLlmProviderProbe({ name: 'x' }), /baseUrl/);
});

test('createLlmProviderProbe returns pass on reachable 2xx', async () => {
  const probe = createLlmProviderProbe({
    name: 'fake',
    baseUrl: 'https://fake.example.com',
    fetchImpl: fakeFetch(200),
  });
  const result = await probe.run({ bypassCache: true });
  assert.equal(result.status, 'pass');
  assert.equal(result.details.httpStatus, 200);
  assert.equal(result.details.provider, 'fake');
});

test('createLlmProviderProbe treats 4xx as reachable pass', async () => {
  const probe = createLlmProviderProbe({
    name: 'fake401',
    baseUrl: 'https://fake.example.com',
    fetchImpl: fakeFetch(401),
  });
  const result = await probe.run({ bypassCache: true });
  assert.equal(result.status, 'pass');
  assert.equal(result.details.httpStatus, 401);
});

test('createLlmProviderProbe records apiKeyEnv gating', async () => {
  const probe = createLlmProviderProbe({
    name: 'gated',
    baseUrl: 'https://api.example.com',
    apiKeyEnv: 'FAKE_KEY',
    fetchImpl: fakeFetch(200),
  });
  const result = await probe.run({ bypassCache: true });
  assert.equal(result.details.gatedBy, 'FAKE_KEY');
});

test('createConfiguredLlmProbes skips providers without API keys', () => {
  const probes = createConfiguredLlmProbes({ env: {} });
  assert.equal(probes.length, 0);
});

test('createConfiguredLlmProbes includes only providers with API keys present', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-test',
    MISTRAL_API_KEY: 'mst-test',
    GROQ_API_KEY: '',
  };
  const probes = createConfiguredLlmProbes({ env });
  const names = probes.map((p) => p.name).sort();
  assert.deepEqual(names, ['provider-anthropic', 'provider-mistral']);
});

test('createConfiguredLlmProbes includeUnconfigured returns all when requested', () => {
  const probes = createConfiguredLlmProbes({ env: {}, includeUnconfigured: true });
  assert.equal(probes.length, PROVIDERS.length);
});

test('PROVIDERS list covers expected vendors', () => {
  const names = PROVIDERS.map((p) => p.name);
  for (const expected of [
    'provider-anthropic',
    'provider-google',
    'provider-mistral',
    'provider-groq',
    'provider-deepseek',
    'provider-openrouter',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('createHealthSystem registers llm probes when env keys present', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-test',
    OPENAI_API_KEY: 'sk-openai',
  };
  const system = createHealthSystem({ env });
  const names = system.registry.list().map((p) => p.name);
  assert.ok(names.includes('memory'), 'memory probe registered');
  assert.ok(names.includes('disk'), 'disk probe registered');
  assert.ok(names.includes('provider-openai'), 'openai probe registered when key present');
  assert.ok(names.includes('provider-anthropic'), 'anthropic probe registered when key present');
  assert.ok(!names.includes('provider-mistral'), 'mistral not registered without key');
});

test('createHealthSystem skips all provider probes when env has no keys', () => {
  const system = createHealthSystem({ env: {} });
  const names = system.registry.list().map((p) => p.name);
  for (const n of names) {
    assert.ok(!n.startsWith('provider-'), `unexpected provider probe ${n}`);
  }
});
