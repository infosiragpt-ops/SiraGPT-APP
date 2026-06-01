'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  listVisibleTextModelDefinitions,
  curateVisibleAdminMediaModels,
  curateVisibleTextModels,
} = require('../src/services/visible-model-catalog');

test('no allowlist → returns the full curated catalog', () => {
  const all = listVisibleTextModelDefinitions({});
  assert.ok(all.length >= 20, `expected the full catalog, got ${all.length}`);
  const names = all.map((m) => m.name);
  assert.ok(names.includes('gpt-4o'));
  assert.ok(names.includes('openai/gpt-5.5'));
});

test('VISIBLE_MODELS_ALLOWLIST restricts the catalog to listed names', () => {
  const env = { VISIBLE_MODELS_ALLOWLIST: 'gpt-4o, phi-4 , openai/gpt-5.5' };
  const filtered = listVisibleTextModelDefinitions(env);
  const names = filtered.map((m) => m.name).sort();
  assert.deepStrictEqual(names, ['gpt-4o', 'openai/gpt-5.5', 'phi-4']);
});

test('allowlist matches by alias too', () => {
  // 'gpt-5' and 'claude-opus-4.7' are aliases of openai/gpt-5.5 and
  // anthropic/claude-opus-4.7 respectively.
  const env = { VISIBLE_MODELS_ALLOWLIST: 'gpt-5,claude-opus-4.7' };
  const names = listVisibleTextModelDefinitions(env).map((m) => m.name).sort();
  assert.deepStrictEqual(names, ['anthropic/claude-opus-4.7', 'openai/gpt-5.5']);
});

test('empty/whitespace allowlist is treated as no filter', () => {
  assert.strictEqual(
    listVisibleTextModelDefinitions({ VISIBLE_MODELS_ALLOWLIST: '   ' }).length,
    listVisibleTextModelDefinitions({}).length,
  );
});

test('curateVisibleTextModels honours the allowlist and requires an admin-active row', () => {
  const env = { VISIBLE_MODELS_ALLOWLIST: 'gpt-4o-mini' };

  assert.deepStrictEqual(curateVisibleTextModels([], env), []);
  assert.deepStrictEqual(
    curateVisibleTextModels([
      { id: 'disabled-mini', name: 'gpt-4o-mini', displayName: 'Disabled', provider: 'OpenAI', type: 'TEXT', isActive: false },
    ], env),
    [],
  );
  assert.deepStrictEqual(
    curateVisibleTextModels([
      { id: '__virtual_gpt_4o_mini__', name: 'gpt-4o-mini', displayName: 'Virtual', provider: 'OpenAI', type: 'TEXT' },
    ], env),
    [],
  );

  const curated = curateVisibleTextModels([
    { id: 'admin-mini', name: 'gpt-4o-mini', displayName: 'GPT-4o Mini DB', provider: 'OpenAI', type: 'TEXT', isActive: true },
  ], env);
  assert.strictEqual(curated.length, 1);
  assert.strictEqual(curated[0].id, 'admin-mini');
  assert.strictEqual(curated[0].name, 'gpt-4o-mini');
  assert.ok(curated[0].id, 'curated model must carry an admin id');
  assert.strictEqual(curated[0].type, 'TEXT');
});

test('curateVisibleAdminMediaModels hides image rows that are inactive, virtual, or not allowed', () => {
  const allowed = new Set(['gpt-image-1', 'gpt-image-2']);
  const curated = curateVisibleAdminMediaModels([
    { id: 'img-1', name: 'gpt-image-1', type: 'IMAGE', isActive: true },
    { id: 'img-2', name: 'gpt-image-2', type: 'IMAGE', isActive: false },
    { id: '__virtual_img__', name: 'gpt-image-2', type: 'IMAGE', isActive: true },
    { id: 'img-3', name: 'bytedance-seed/seedream-4.5', type: 'IMAGE', isActive: true },
    { id: 'vid-1', name: 'veo-fast', type: 'VIDEO', isActive: true },
  ], 'IMAGE', { allowedNames: allowed });

  assert.deepStrictEqual(curated.map((m) => m.name), ['gpt-image-1']);
});

test('curateVisibleAdminMediaModels hides video rows unless Admin marks a real row active', () => {
  const curated = curateVisibleAdminMediaModels([
    { id: 'vid-1', name: 'veo-fast', type: 'VIDEO', isActive: false },
    { id: '__virtual_veo_fast__', name: 'veo-fast', type: 'VIDEO', isActive: true },
    { id: 'img-1', name: 'gpt-image-1', type: 'IMAGE', isActive: true },
    { id: 'vid-2', name: 'kling-1.6', type: 'VIDEO', isActive: true },
  ], 'VIDEO');

  assert.deepStrictEqual(curated.map((m) => m.name), ['kling-1.6']);
});
