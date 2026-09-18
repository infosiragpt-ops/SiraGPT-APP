'use strict';

/**
 * «Activar = visible» for IMAGE models: an admin-activated image model the
 * engine can route is offered in the picker and accepted by /generate-image
 * even when it is not in the static verified allow-list. Models the engine
 * cannot route (no provider inferable) stay hidden.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { curateVisibleAdminMediaModels } = require('../src/services/visible-model-catalog');
const { resolveImageModelRoute } = require('../src/services/media/image-engine');

const active = (name, provider) => ({ id: name, name, provider, type: 'IMAGE', isActive: true });

test('picker: active + routable image models pass even outside the verified list; unroutable ones stay hidden', () => {
  const rows = [
    active('gpt-image-2-2026-04-21', 'OpenAI'),
    active('gpt-image-2.5-flare-2026-09-08', 'OpenAI'),
    active('imagen-4.0-ultra-generate-001', 'Gemini'),
    active('fal-ai/flux-pro/v1.1', 'Fal'),
    active('google/gemini-3.1-flash-lite-image', 'OpenRouter'),
    active('muse-image-1.0', 'Meta'),
    { ...active('gpt-image-1', 'OpenAI'), isActive: false },
  ];
  const allowed = new Set(['gpt-image-2-2026-04-21']);
  const before = curateVisibleAdminMediaModels(rows, 'IMAGE', { allowedNames: allowed }).map((m) => m.name);
  assert.deepEqual(before, ['gpt-image-2-2026-04-21'], 'legacy behaviour: only the verified list');
  const after = curateVisibleAdminMediaModels(rows, 'IMAGE', { allowedNames: allowed, isRoutable: (n) => Boolean(resolveImageModelRoute(n)) }).map((m) => m.name);
  assert.deepEqual(after, [
    'gpt-image-2-2026-04-21',
    'gpt-image-2.5-flare-2026-09-08',
    'imagen-4.0-ultra-generate-001',
    'fal-ai/flux-pro/v1.1',
    'google/gemini-3.1-flash-lite-image',
  ]);
  assert.equal(after.includes('muse-image-1.0'), false, 'no engine route → hidden');
  assert.equal(after.includes('gpt-image-1'), false, 'inactive stays hidden');
  const throwing = curateVisibleAdminMediaModels(rows, 'IMAGE', { allowedNames: allowed, isRoutable: () => { throw new Error('x'); } });
  assert.equal(throwing.length, 1, 'a throwing predicate degrades to the allow-list');
});

test('ai.js: the picker route passes the engine router and /generate-image accepts active routable models', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /allowedNames: VERIFIED_CHAT_IMAGE_MODEL_NAMES,\n\s+isRoutable: isRoutableImageModelName,/);
  assert.match(src, /if \(!isVerifiedChatImageModelName\(model\) && !activeGrokImage && !isActiveRoutableImageModel\(adminModel, model\)\)/);
  assert.match(src, /function isActiveRoutableImageModel\(adminModel, name\)/);
});
