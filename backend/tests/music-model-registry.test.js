const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/services/ai/music-model-registry');

test('resolveMusicModel: Suno display names, ids and gateway models', () => {
  assert.deepEqual(registry.resolveMusicModel('Suno V4'), {
    key: 'sunoV4', provider: 'suno', gatewayModel: registry.MODEL_IDS.sunoV4, label: 'Suno V4',
  });
  assert.equal(registry.resolveMusicModel('suno-v4').key, 'sunoV4');
  assert.equal(registry.resolveMusicModel('Suno V3.5').key, 'sunoV35');
  assert.equal(registry.resolveMusicModel('Suno V3.5').provider, 'suno');
  assert.equal(registry.resolveMusicModel('suno-v3.5').gatewayModel, registry.MODEL_IDS.sunoV35);
  assert.equal(registry.resolveMusicModel('V4').key, 'sunoV4');
});

test('resolveMusicModel: MiniMax plus the legacy Mimo spelling', () => {
  const minimax = registry.resolveMusicModel('MiniMax');
  assert.equal(minimax.key, 'minimax');
  assert.equal(minimax.provider, 'minimax');
  assert.equal(minimax.label, 'MiniMax');
  assert.equal(registry.resolveMusicModel('Mimo Max 02HD').key, 'minimax');
  assert.equal(registry.resolveMusicModel('mimo').provider, 'minimax');
});

test('resolveMusicModel: ElevenLabs and Lyria route to their providers', () => {
  assert.deepEqual(registry.resolveMusicModel('ElevenLabs'), {
    key: 'elevenlabs', provider: 'elevenlabs', gatewayModel: 'elevenlabs', label: 'ElevenLabs Music',
  });
  assert.equal(registry.isElevenLabsSelection('ElevenLabs'), true);
  assert.equal(registry.isElevenLabsSelection('Suno V4'), false);
  const lyria = registry.resolveMusicModel('Lyria 3 Pro');
  assert.equal(lyria.key, 'lyria');
  assert.equal(lyria.provider, 'openrouter');
  assert.equal(lyria.gatewayModel, registry.MODEL_IDS.lyria);
});

test('resolveMusicModel: fully-qualified slugs pass through to OpenRouter', () => {
  assert.deepEqual(registry.resolveMusicModel('my-vendor/my-music-model'), {
    key: 'custom', provider: 'openrouter', gatewayModel: 'my-vendor/my-music-model', label: 'my-vendor/my-music-model',
  });
});

test('resolveMusicModel: empty/unknown values fall back to the composer default', () => {
  for (const input of ['', 'Auto', undefined, 'something-unknown']) {
    const resolved = registry.resolveMusicModel(input);
    assert.equal(resolved.key, 'sunoV4');
    assert.equal(resolved.provider, 'suno');
  }
});
