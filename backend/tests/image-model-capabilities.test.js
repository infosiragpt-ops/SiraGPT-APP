'use strict';

// IMAGE catalog rows tell whether the engine can EDIT with them, so a
// generation-only row (the legacy seeds, DALL-E, Imagen) is visible as
// «no edita» in the picker and in Admin → Modelos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { imageModelCapabilities, withImageCapabilities, engineProviderFor } = require('../src/services/media/image-model-capabilities');

test('generation-only rows report imageEdit:false, editors report true, non-image rows report null', () => {
  for (const row of [
    { name: 'openai/dall-e-3', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'google/imagen-3-0', provider: 'Gemini', type: 'IMAGE' },
    { name: 'dall-e-3', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'imagen-4.0-generate-001', provider: 'Gemini', type: 'IMAGE' },
    { name: 'fal-ai/flux/schnell', provider: 'Fal', type: 'IMAGE' },
    { name: 'grok-2-image', provider: 'xAI', type: 'IMAGE' },
  ]) assert.deepEqual(imageModelCapabilities(row), { imageEdit: false }, row.name);
  for (const row of [
    { name: 'gpt-image-1', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'gpt-image-2', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'gemini-2.5-flash-image', provider: 'Gemini', type: 'IMAGE' },
    { name: 'google/gemini-3.1-flash-image-preview', provider: 'OpenRouter', type: 'IMAGE' },
  ]) assert.deepEqual(imageModelCapabilities(row), { imageEdit: true }, row.name);
  assert.equal(imageModelCapabilities({ name: 'gpt-4o-mini', provider: 'OpenAI', type: 'TEXT' }), null);
  assert.equal(imageModelCapabilities(null), null);
  assert.equal(imageModelCapabilities('gpt-image-1'), null);
});

test('withImageCapabilities decorates image rows only and keeps existing capabilities', () => {
  const text = { name: 'gpt-4o', provider: 'OpenAI', type: 'TEXT' };
  assert.equal(withImageCapabilities(text), text);
  const image = withImageCapabilities({ name: 'gpt-image-1', provider: 'OpenAI', type: 'IMAGE', capabilities: { vision: true } });
  assert.deepEqual(image.capabilities, { vision: true, imageEdit: true });
  assert.equal(engineProviderFor('OpenRouter'), 'openrouter');
  assert.equal(engineProviderFor('Google'), 'gemini');
  assert.equal(engineProviderFor('Meta'), undefined);
});

test('the picker and the admin listing expose capabilities for IMAGE rows', () => {
  const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(ai, /require\('\.\.\/services\/media\/image-model-capabilities'\)\.imageModelCapabilities\(m\)/);
  const admin = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  assert.match(admin, /const \{ withImageCapabilities \} = require\('\.\.\/services\/media\/image-model-capabilities'\);\s*res\.json\(\{ models: models\.map\(/);
});
