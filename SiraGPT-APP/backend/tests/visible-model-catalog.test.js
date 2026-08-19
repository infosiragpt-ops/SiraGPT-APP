'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  listVisibleTextModelDefinitions,
  curateVisibleAdminMediaModels,
  curateVisibleTextModels,
} = require('../src/services/visible-model-catalog');
const { getContextLimit } = require('../src/services/context-window');
const tokenBudget = require('../src/services/ai/token-budget');
const pricing = require('../src/services/ai/pricing.json');

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

test('curateVisibleTextModels surfaces admin-activated TEXT models even when not catalogued ("activar = visible")', () => {
  const out = curateVisibleTextModels([
    { id: 'custom-1', name: 'CustomCorp/llama-99b', displayName: 'Llama 99B', provider: 'OpenRouter', type: 'TEXT', isActive: true },
    { id: 'off-1', name: 'CustomCorp/off', type: 'TEXT', isActive: false },
    { id: 'img-1', name: 'SomeImage', type: 'IMAGE', isActive: true },
    { id: '__virtual_x__', name: 'VirtualOne', type: 'TEXT' },
  ], {}); // no allowlist
  const names = out.map((m) => m.name);
  assert.ok(names.includes('CustomCorp/llama-99b'), 'active uncatalogued TEXT model is surfaced');
  assert.ok(!names.includes('CustomCorp/off'), 'inactive model stays hidden');
  assert.ok(!names.includes('SomeImage'), 'non-TEXT model is not surfaced by the TEXT curator');
  assert.ok(!names.includes('VirtualOne'), 'virtual rows are excluded');
  const passthrough = out.find((m) => m.name === 'CustomCorp/llama-99b');
  assert.strictEqual(passthrough.displayName, 'Llama 99B');
  assert.strictEqual(passthrough.id, 'custom-1');
});

test('passthrough still respects VISIBLE_MODELS_ALLOWLIST when set', () => {
  const models = [
    { id: 'c1', name: 'CustomCorp/llama-99b', type: 'TEXT', isActive: true },
  ];
  assert.deepStrictEqual(
    curateVisibleTextModels(models, { VISIBLE_MODELS_ALLOWLIST: 'gpt-4o' }).map((m) => m.name),
    [],
  );
  assert.deepStrictEqual(
    curateVisibleTextModels(models, { VISIBLE_MODELS_ALLOWLIST: 'customcorp/llama-99b' }).map((m) => m.name),
    ['CustomCorp/llama-99b'],
  );
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

// ── Regression: the Grok entry used to ship the id "x-ai/grok-4.2",
// which OpenRouter rejects with `400 ... is not a valid model id`. The
// canonical slug is "x-ai/grok-4.20". The legacy ids stay as aliases so
// any historical selection keeps resolving to the corrected model.
test('grok catalog entry uses the valid OpenRouter id (not the 400-ing x-ai/grok-4.2)', () => {
  const names = listVisibleTextModelDefinitions({}).map((m) => m.name);
  assert.ok(names.includes('x-ai/grok-4.20'), 'expected the corrected grok id in the catalog');
  assert.ok(!names.includes('x-ai/grok-4.2'), 'x-ai/grok-4.2 is NOT a valid OpenRouter model id');
});

test('legacy grok ids still resolve via the allowlist alias path', () => {
  for (const legacy of ['x-ai/grok-4.2', 'grok-4.2']) {
    const names = listVisibleTextModelDefinitions({ VISIBLE_MODELS_ALLOWLIST: legacy }).map((m) => m.name);
    assert.deepStrictEqual(names, ['x-ai/grok-4.20'], `allowlist "${legacy}" must resolve to the corrected model`);
  }
});

test('grok canonical id is keyed in the context-window, token-budget and pricing tables', () => {
  assert.strictEqual(getContextLimit('x-ai/grok-4.20'), 256000);
  assert.strictEqual(tokenBudget._CONTEXT_WINDOWS['x-ai/grok-4.20'], 256_000);
  assert.ok(pricing.models['x-ai/grok-4.20'], 'pricing.json must carry an x-ai/grok-4.20 entry');
  assert.strictEqual(pricing.models['x-ai/grok-4.20'].provider, 'OpenRouter');
});
