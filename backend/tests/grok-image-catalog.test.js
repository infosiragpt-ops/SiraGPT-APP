'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferModelOutputType,
  isActiveGrokImageModel,
  normalizeCatalogModelType,
} = require('../src/services/model-output-type');
const {
  curateVisibleTextModels,
  curateVisibleAdminMediaModels,
} = require('../src/services/visible-model-catalog');

const grok = {
  id: 'admin-grok-image',
  name: 'x-ai/grok-imagine-image-2.0',
  displayName: 'Grok Imagine Image 2.0',
  provider: 'OpenRouter',
  type: 'TEXT', // Legacy sync misclassified this row.
  isActive: true,
};

test('generation classification uses output modalities without treating vision input as image generation', () => {
  for (const metadata of [
    { architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    { architecture: { modality: 'text->image' } },
    { supported_output_modalities: ['image'] },
    { output_modalities: ['text', 'image'] },
  ]) {
    assert.equal(inferModelOutputType('new-provider/new-model', metadata), 'IMAGE');
  }
  for (const metadata of [
    { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { architecture: { modality: 'text+image->text' } },
    { input: ['image'], output: ['text'] },
    { supported_modalities: ['text', 'image'] },
    { input: ['image'] },
  ]) {
    assert.equal(inferModelOutputType('grok-4.6', metadata), 'TEXT');
  }
  assert.equal(inferModelOutputType('new-video', { output: ['image', 'video'] }), 'VIDEO');
});

test('Grok image ids are recognized when a provider omits output metadata', () => {
  for (const id of ['grok-imagine-image-2.0', 'x-ai/grok-imagine-image-2.0', 'grok-2-image', 'grok-imagine-image']) {
    assert.equal(inferModelOutputType(id), 'IMAGE');
  }
  assert.equal(inferModelOutputType('grok-4.6'), 'TEXT');
  assert.equal(inferModelOutputType('grok-imagine-video'), 'VIDEO');
});

test('an activated legacy TEXT Grok image row moves to Images without changing its activation or database data', () => {
  const original = { ...grok };
  const rows = [
    grok,
    { id: 'chat', name: 'x-ai/grok-4.6', provider: 'OpenRouter', type: 'TEXT', isActive: true },
  ];
  const text = curateVisibleTextModels(rows, {});
  const images = curateVisibleAdminMediaModels(rows, 'IMAGE', { allowedNames: new Set(['gpt-image-2']) });
  assert.deepEqual(text.map((row) => row.name), ['x-ai/grok-4.6']);
  assert.deepEqual(images.map((row) => row.name), [grok.name]);
  assert.equal(images[0].type, 'IMAGE');
  assert.equal(images[0].provider, 'xAI');
  assert.equal(images[0].id, grok.id);
  assert.equal(images[0].isActive, true);
  assert.deepEqual(grok, original);
});

test('the Grok exception does not activate models or widen the existing image allowlist', () => {
  const rows = [
    { ...grok, isActive: false },
    { ...grok, id: '__virtual_grok__' },
    { ...grok, virtual: true },
    { ...grok, provider: 'Anthropic' },
    { id: 'other', name: 'other/image', provider: 'OpenRouter', type: 'IMAGE', isActive: true },
    { id: 'verified', name: 'gpt-image-2', provider: 'OpenAI', type: 'IMAGE', isActive: true },
  ];
  const images = curateVisibleAdminMediaModels(rows, 'IMAGE', { allowedNames: new Set(['gpt-image-2']) });
  assert.deepEqual(images.map((row) => row.name), ['gpt-image-2']);
  for (const row of rows.slice(0, 5)) assert.equal(isActiveGrokImageModel(row), false);
  assert.equal(isActiveGrokImageModel({ ...grok, provider: 'xAI', name: 'grok-imagine-image-2.0' }), true);
});

test('read normalization leaves unrelated admin model types intact', () => {
  for (const type of ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'MUSIC']) {
    assert.equal(normalizeCatalogModelType({ name: 'custom-model', type }).type, type);
  }
});
