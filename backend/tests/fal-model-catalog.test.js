'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferBrand, isUtility, categoryGroup, inferTierRank, classifyFalModel, sortFalModels,
} = require('../src/services/fal/fal-classify');
const { listFalModels, getFalCatalog, findFalModel, GROUPS } = require('../src/services/fal-model-catalog');

test('inferBrand maps known fal endpoints to brand + iconKey', () => {
  assert.deepEqual(inferBrand('fal-ai/flux-2-pro'), { brand: 'Black Forest Labs', iconKey: 'flux' });
  assert.deepEqual(inferBrand('fal-ai/kling-video/v3/pro/text-to-video'), { brand: 'Kling AI', iconKey: 'kling' });
  assert.deepEqual(inferBrand('fal-ai/veo3.1'), { brand: 'Google', iconKey: 'veo' });
  assert.deepEqual(inferBrand('fal-ai/sora-2/text-to-video'), { brand: 'OpenAI', iconKey: 'sora' });
  assert.deepEqual(inferBrand('xai/grok-imagine-video/text-to-video'), { brand: 'xAI', iconKey: 'grok' });
  assert.equal(inferBrand('fal-ai/some-unknown-model').iconKey, 'fal'); // generic fallback
});

test('isUtility filters pure utilities, keeps creative gen/edit', () => {
  assert.equal(isUtility('fal-ai/esrgan'), true);
  assert.equal(isUtility('fal-ai/ffmpeg-api/merge-audios'), true);
  assert.equal(isUtility('fal-ai/demucs'), true);
  assert.equal(isUtility('fal-ai/flux-pro/kontext'), false); // edit = creative
  assert.equal(isUtility('fal-ai/flux/dev'), false);
});

test('categoryGroup buckets categories into image/video/audio/3d', () => {
  assert.equal(categoryGroup('text-to-image'), 'image');
  assert.equal(categoryGroup('image-to-video'), 'video');
  assert.equal(categoryGroup('text-to-speech'), 'audio');
  assert.equal(categoryGroup('image-to-3d'), '3d');
});

test('inferTierRank pins flagships high and pulls fast/lite variants down', () => {
  assert.equal(inferTierRank('fal-ai/sora-2/text-to-video/pro'), 5);
  assert.equal(inferTierRank('fal-ai/flux-2-pro'), 5);
  assert.ok(inferTierRank('fal-ai/flux/schnell') <= 2, 'schnell is a fast variant');
  assert.ok(inferTierRank('fal-ai/kling-video/v3/standard/text-to-video') >= 3);
});

test('classifyFalModel returns null for utilities and an enriched record otherwise', () => {
  assert.equal(classifyFalModel({ id: 'fal-ai/clarity-upscaler', title: 'Upscaler', category: 'image-to-image' }), null);
  const rec = classifyFalModel({ id: 'fal-ai/flux-2-pro', title: 'Flux 2 Pro', category: 'text-to-image', tags: [] });
  assert.equal(rec.brand, 'Black Forest Labs');
  assert.equal(rec.iconKey, 'flux');
  assert.equal(rec.group, 'image');
  assert.equal(rec.qualityTier, 'Ultra');
  assert.equal(rec.endpoint, 'fal-ai/flux-2-pro');
});

test('sortFalModels orders by quality desc then brand prestige', () => {
  const sorted = sortFalModels([
    classifyFalModel({ id: 'fal-ai/flux/schnell', title: 'FLUX schnell', category: 'text-to-image' }),
    classifyFalModel({ id: 'fal-ai/flux-2-pro', title: 'Flux 2 Pro', category: 'text-to-image' }),
  ]);
  assert.equal(sorted[0].displayName, 'Flux 2 Pro', 'Ultra before Fast');
});

test('generated catalog is non-trivial and well-formed', () => {
  const cat = getFalCatalog();
  assert.ok(cat.count > 200, `expected a large catalog, got ${cat.count}`);
  assert.deepEqual(cat.groups, GROUPS);
  // every model has the fields the gallery renders
  for (const m of cat.models.slice(0, 50)) {
    assert.ok(m.id && m.displayName && m.brand && m.iconKey && m.group && m.qualityTier);
  }
});

test('listFalModels filters by group and search, stays quality-ordered', () => {
  const video = listFalModels({ group: 'video' });
  assert.ok(video.length > 0 && video.every((m) => m.group === 'video'));
  for (let i = 1; i < video.length; i++) assert.ok(video[i - 1].tierRank >= video[i].tierRank);
  const flux = listFalModels({ search: 'flux' });
  assert.ok(flux.length > 0 && flux.every((m) => /flux/i.test(`${m.displayName} ${m.brand} ${m.id}`)));
});

test('no pure-utility models survived into the generated catalog', () => {
  const all = getFalCatalog().models;
  assert.ok(!all.some((m) => /esrgan|ffmpeg|demucs|clarity-upscaler|\baudio-isolation\b/.test(m.id)));
  assert.ok(findFalModel(all[0].id), 'findFalModel resolves a known id');
});
