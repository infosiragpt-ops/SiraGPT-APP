'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConfiguredExternalProbes,
  EXTERNAL_PROVIDERS,
} = require('../src/health/probes/provider-external');
const { createHealthSystem } = require('../src/health/mount');

test('EXTERNAL_PROVIDERS covers billing, image/video, search, voice', () => {
  const names = EXTERNAL_PROVIDERS.map((p) => p.name);
  for (const expected of [
    'provider-stripe',
    'provider-fal',
    'provider-tavily',
    'provider-exa',
    'provider-firecrawl',
    'provider-elevenlabs',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('every entry has the required shape', () => {
  for (const p of EXTERNAL_PROVIDERS) {
    assert.equal(typeof p.name, 'string');
    assert.match(p.baseUrl, /^https?:\/\//);
    assert.equal(typeof p.apiKeyEnv, 'string');
  }
});

test('createConfiguredExternalProbes skips when no keys are present', () => {
  const probes = createConfiguredExternalProbes({ env: {} });
  assert.equal(probes.length, 0);
});

test('createConfiguredExternalProbes registers only configured providers', () => {
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    FAL_KEY: 'fal_y',
    EXA_API_KEY: '',
  };
  const probes = createConfiguredExternalProbes({ env });
  const names = probes.map((p) => p.name).sort();
  assert.deepEqual(names, ['provider-fal', 'provider-stripe']);
});

test('createConfiguredExternalProbes includeUnconfigured returns all', () => {
  const probes = createConfiguredExternalProbes({ env: {}, includeUnconfigured: true });
  assert.equal(probes.length, EXTERNAL_PROVIDERS.length);
});

test('createHealthSystem registers external probes when env keys present', () => {
  const env = {
    STRIPE_SECRET_KEY: 'sk_test',
    TAVILY_API_KEY: 'tv-x',
  };
  const system = createHealthSystem({ env });
  const names = system.registry.list().map((p) => p.name);
  assert.ok(names.includes('provider-stripe'), 'stripe probe registered');
  assert.ok(names.includes('provider-tavily'), 'tavily probe registered');
  assert.ok(!names.includes('provider-fal'), 'fal not registered without FAL_KEY');
});

test('createHealthSystem skips all external probes when env has no keys', () => {
  const system = createHealthSystem({ env: {} });
  const names = system.registry.list().map((p) => p.name);
  for (const n of names) {
    if (n === 'provider-openai') continue;
    if (!n.startsWith('provider-')) continue;
    assert.fail(`unexpected provider probe ${n}`);
  }
});

test('probes inherit DEGRADED category from factory default', () => {
  const probes = createConfiguredExternalProbes({
    env: { STRIPE_SECRET_KEY: 'sk_test' },
  });
  assert.equal(probes.length, 1);
  assert.equal(probes[0].category, 'degraded');
});

test('probes accept fetchImpl injection for testability', async () => {
  const probes = createConfiguredExternalProbes({
    env: { STRIPE_SECRET_KEY: 'sk_test' },
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(probes.length, 1);
  const result = await probes[0].run({ bypassCache: true });
  assert.equal(result.status, 'pass');
  assert.equal(result.details.provider, 'provider-stripe');
});
