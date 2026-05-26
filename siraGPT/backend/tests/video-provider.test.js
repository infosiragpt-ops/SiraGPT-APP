'use strict';

// F4 PR17 — Unit tests for the video-provider abstraction. Verifies
// provider switch, mock disclaimer surface, and PROVIDER_DOWN for keys
// not configured.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire(modulePath, envOverrides = {}) {
  // Reload the module with a clean env so DEFAULT_PROVIDER picks up
  // the test-scoped value.
  const fullPath = require.resolve(modulePath);
  delete require.cache[fullPath];
  const origEnv = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = require(modulePath);
  process.env = origEnv;
  return mod;
}

test('providerStatus: mock provider is always configured + carries disclaimer', () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'mock' });
  const status = vp.providerStatus();
  assert.equal(status.provider, 'mock');
  assert.equal(status.configured, true);
  assert.equal(status.isMock, true);
  assert.match(status.disclaimer, /Vista previa simulada/);
});

test('providerStatus: pika is unconfigured without PIKA_API_KEY', () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'pika', PIKA_API_KEY: null });
  const status = vp.providerStatus();
  assert.equal(status.provider, 'pika');
  assert.equal(status.configured, false);
  assert.match(status.reason, /PIKA_API_KEY/);
  assert.equal(status.isMock, false);
  assert.equal(status.disclaimer, null);
});

test('providerStatus: runway is unconfigured without RUNWAY_API_KEY', () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'runway', RUNWAY_API_KEY: null });
  const status = vp.providerStatus();
  assert.equal(status.provider, 'runway');
  assert.equal(status.configured, false);
  assert.equal(status.isMock, false);
});

test('providerStatus: unknown provider falls to PROVIDER_DOWN with explicit reason', () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'sora' });
  const status = vp.providerStatus();
  assert.equal(status.configured, false);
  assert.match(status.reason, /unknown provider/);
});

test('generate(mock): returns a provisional SVG storyboard with isMock=true assets', async () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'mock' });
  const result = await vp.generate({ prompt: 'a sunset over mountains', durationSeconds: 6 });
  assert.equal(result.ok, true);
  assert.equal(result.providerUsed, 'mock');
  assert.equal(result.provisional, true);
  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0].url, /^data:image\/svg\+xml/);
  assert.equal(result.assets[0].isMock, true);
  assert.equal(result.assets[0].durationSeconds, 6);
});

test('generate(mock): clamps oversized durationSeconds and applies default for missing/0', async () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'mock' });
  const omitted = await vp.generate({ prompt: 'x' });
  const tooLong = await vp.generate({ prompt: 'x', durationSeconds: 500 });
  const negative = await vp.generate({ prompt: 'x', durationSeconds: -3 });
  assert.equal(omitted.assets[0].durationSeconds, 4, 'default duration is 4s');
  assert.equal(tooLong.assets[0].durationSeconds, 30, 'must clamp to 30');
  assert.equal(negative.assets[0].durationSeconds, 1, 'negative clamps to min 1');
});

test('generate(pika): PROVIDER_DOWN without PIKA_API_KEY', async () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'pika', PIKA_API_KEY: null });
  const result = await vp.generate({ prompt: 'x', provider: 'pika' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DOWN');
  assert.equal(result.providerUsed, 'pika');
});

test('generate(pika): NOT_READY when key present (real integration deferred)', async () => {
  const orig = process.env.PIKA_API_KEY;
  process.env.PIKA_API_KEY = 'test-key';
  try {
    const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'pika' });
    const result = await vp.generate({ prompt: 'x', provider: 'pika' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NOT_READY');
  } finally {
    if (orig === undefined) delete process.env.PIKA_API_KEY;
    else process.env.PIKA_API_KEY = orig;
  }
});

test('generate(none): always PROVIDER_DOWN', async () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'none' });
  const result = await vp.generate({ prompt: 'x', provider: 'none' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DOWN');
});

test('effectiveProvider: spec.provider overrides DEFAULT_PROVIDER', () => {
  const vp = freshRequire('../src/services/video-provider', { VIDEO_PROVIDER: 'mock' });
  assert.equal(vp.effectiveProvider({ provider: 'pika' }), 'pika');
  assert.equal(vp.effectiveProvider({}), 'mock');
  assert.equal(vp.effectiveProvider(), 'mock');
});
