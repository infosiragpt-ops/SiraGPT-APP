'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveFalVideoModelRequest, buildFalVideoInputPayload } = require('../src/services/fal-video-model-catalog');
const { directVideoPrompt } = require('../src/services/video-prompt-director');
const refs = (n) => Array.from({ length: n }, (_, i) => `https://example.com/ref-${i}.png`);

test('reference overflow is rejected instead of silently losing references', () => {
  for (const [model, count] of [
    ['bytedance/seedance-2.0/reference-to-video', 10],
    ['fal-ai/veo3.1/fast', 2],
    ['fal-ai/kling-video/v3/pro/image-to-video', 3],
  ]) {
    const routed = resolveFalVideoModelRequest(model, { hasImage: true, imageCount: count });
    assert.equal(routed.ok, false, model);
    assert.equal(routed.code, 'E_PARAMS');
    assert.match(routed.message, /referencia|imagen/);
  }
});

test('payload builder independently refuses reference loss and wrong endpoint modes', () => {
  for (const [endpoint, count] of [
    ['bytedance/seedance-2.0/reference-to-video', 10],
    ['fal-ai/veo3.1/fast/image-to-video', 2],
    ['fal-ai/kling-video/v3/pro/image-to-video', 3],
    ['fal-ai/veo3.1/fast', 1],
  ]) {
    assert.throws(() => buildFalVideoInputPayload({ endpoint, prompt: 'Anima todas las referencias', imageUrls: refs(count) }), { code: 'E_PARAMS' });
  }
});

test('supported references preserve full original ordering', () => {
  const images = refs(9);
  const routed = resolveFalVideoModelRequest('bytedance/seedance-2.0/text-to-video', { hasImage: true, imageCount: images.length });
  assert.equal(routed.ok, true);
  const payload = buildFalVideoInputPayload({ endpoint: routed.endpoint, prompt: '@Image1 y @Image9', imageUrls: images });
  assert.deepEqual(payload.image_urls, images);
});

test('video continuity does not override explicitly selected model or capture settings', () => {
  const directed = directVideoPrompt({
    prompt: 'continúa con los mismos personajes', endpoint: 'fal-ai/veo3.1/fast',
    aspectRatio: '16:9', resolution: '1080p', audio: false,
    history: [{ prompt: 'una astronauta en Marte', model: 'bytedance/seedance-2.0/text-to-video', aspect_ratio: '9:16', resolution: '720p', audio: true }],
  });
  assert.equal(directed.continuityMode, 'strict');
  assert.deepEqual(directed.settings, { model: 'fal-ai/veo3.1/fast', aspect_ratio: '16:9', resolution: '1080p', audio: false });
  assert.deepEqual(directed.settingsLocked, []);
});

test('professional direction preserves every user instruction even in long briefs', () => {
  const prompt = `${'Producto rojo, iluminación suave. '.repeat(55)}CIERRE: conserva el logotipo exacto y muestra precio 49.`;
  const directed = directVideoPrompt({ prompt, history: [{ prompt: 'una escena anterior' }], continuation: true });
  assert.ok(directed.prompt.includes(prompt));
});

test('reference conditioning is explicit and does not suppress requested branding', () => {
  const directed = directVideoPrompt({ prompt: 'Anima mi producto con su logotipo original', imageCount: 2, endpoint: 'bytedance/seedance-2.0/reference-to-video' });
  assert.match(directed.prompt, /@Image1/);
  assert.match(directed.prompt, /@Image2/);
  assert.match(directed.prompt, /identity|appearance/);
  assert.doesNotMatch(directed.negativePrompt, /\blogo\b|\btext overlay\b/);
});
