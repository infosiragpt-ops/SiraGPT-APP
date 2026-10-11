'use strict';

// IMAGE catalog rows tell whether the composer can EDIT with them, so a
// generation-only row (the legacy seeds, DALL-E, Imagen, Flux, Grok) is
// visible as «no edita» in the picker and in Admin → Modelos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { imageModelCapabilities, withImageCapabilities, engineProviderFor, engineProviderForModel } = require('../src/services/media/image-model-capabilities');

test('generation-only rows report imageEdit:false, editors report true, non-image rows report null', () => {
  for (const row of [
    { name: 'openai/dall-e-3', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'google/imagen-3-0', provider: 'Gemini', type: 'IMAGE' },
    { name: 'dall-e-3', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'imagen-4.0-generate-001', provider: 'Gemini', type: 'IMAGE' },
    { name: 'fal-ai/flux/schnell', provider: 'Fal', type: 'IMAGE' },
    // The composer always refuses edits with Grok, direct or via OpenRouter.
    { name: 'grok-2-image', provider: 'xAI', type: 'IMAGE' },
    { name: 'x-ai/grok-2-image', provider: 'OpenRouter', type: 'IMAGE' },
    // OpenRouter text-to-image rows cannot take an input image.
    { name: 'black-forest-labs/flux-1.1-pro', provider: 'OpenRouter', type: 'IMAGE' },
    { name: 'recraftai/recraft-v3', provider: 'OpenRouter', type: 'IMAGE' },
    { name: 'ideogram/ideogram-v2', provider: 'OpenRouter', type: 'IMAGE' },
  ]) assert.deepEqual(imageModelCapabilities(row), { imageEdit: false }, row.name);
  for (const row of [
    { name: 'gpt-image-1', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'gpt-image-2', provider: 'OpenAI', type: 'IMAGE' },
    { name: 'gemini-2.5-flash-image', provider: 'Gemini', type: 'IMAGE' },
    // The default-active OpenRouter editors (a slug runs on OpenRouter).
    { name: 'google/gemini-3.1-flash-image-preview', provider: 'OpenRouter', type: 'IMAGE' },
    { name: 'google/gemini-2.5-flash-image', provider: 'OpenRouter', type: 'IMAGE' },
    { name: 'openai/gpt-5.4-image-2', provider: 'OpenRouter', type: 'IMAGE' },
    { name: 'bytedance-seed/seedream-4.5', provider: 'OpenRouter', type: 'IMAGE' },
  ]) assert.deepEqual(imageModelCapabilities(row), { imageEdit: true }, row.name);
  assert.equal(imageModelCapabilities({ name: 'gpt-4o-mini', provider: 'OpenAI', type: 'TEXT' }), null);
  assert.equal(imageModelCapabilities(null), null);
  assert.equal(imageModelCapabilities('gpt-image-1'), null);
});

test('the flag resolves the provider exactly like the composer: a catalog slug runs on OpenRouter whatever family it belongs to', () => {
  const { resolveGenerateProvider } = require('../src/services/ai/provider-inference');
  // The chat inference sends google/… slugs to Gemini; the image engine cannot
  // run a slug on the direct Google API, so the model-aware provider is OpenRouter.
  assert.equal(resolveGenerateProvider('OpenRouter', 'google/gemini-3.1-flash-image-preview'), 'Gemini');
  assert.equal(engineProviderForModel('Gemini', 'google/gemini-3.1-flash-image-preview'), 'openrouter');
  assert.equal(engineProviderForModel('OpenAI', 'openai/gpt-5.4-image-2'), 'openrouter');
  assert.equal(engineProviderForModel('Fal', 'fal-ai/flux/schnell'), 'fal');
  assert.equal(engineProviderForModel('OpenRouter', 'x-ai/grok-2-image'), 'xai');
  // Bare ids keep the resolved provider.
  assert.equal(engineProviderForModel('Gemini', 'gemini-2.5-flash-image'), 'gemini');
  assert.equal(engineProviderForModel('OpenAI', 'gpt-image-1'), 'openai');
  assert.equal(engineProviderForModel('Meta', 'muse-image-1.0'), undefined);
  assert.equal(engineProviderFor('OpenRouter'), 'openrouter');
  assert.equal(engineProviderFor('Google'), 'gemini');
  assert.equal(engineProviderFor('Meta'), undefined);
});

test('withImageCapabilities decorates image rows only and keeps existing capabilities', () => {
  const text = { name: 'gpt-4o', provider: 'OpenAI', type: 'TEXT' };
  assert.equal(withImageCapabilities(text), text);
  const image = withImageCapabilities({ name: 'gpt-image-1', provider: 'OpenAI', type: 'IMAGE', capabilities: { vision: true } });
  assert.deepEqual(image.capabilities, { vision: true, imageEdit: true });
});

test('the picker, the admin listing and the composer share the model-aware provider', () => {
  const ai = fs.readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
  assert.match(ai, /require\('\.\.\/services\/media\/image-model-capabilities'\)\.imageModelCapabilities\(m\)/);
  assert.match(ai, /const engineProviderForPick = \(p = provider, m = model\) => \{\s*try \{ return require\('\.\.\/services\/media\/image-model-capabilities'\)\.engineProviderForModel\(p, m\) \|\| toImageEngineProvider\(p\); \}/);
  // Every engine call of the composer handler goes through it.
  assert.match(ai, /canEditImage\(\{ model, provider: engineProviderForPick\(\), background \}\)/);
  assert.match(ai, /canEditImage\(\{ model, provider: engineProviderForPick\(\) \}\)/);
  assert.match(ai, /model, provider: engineProviderForPick\(\), aspectRatio, quality, n: imageCount, background,/);
  const admin = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  assert.match(admin, /const \{ withImageCapabilities \} = require\('\.\.\/services\/media\/image-model-capabilities'\);\s*res\.json\(\{ models: models\.map\(/);
});
