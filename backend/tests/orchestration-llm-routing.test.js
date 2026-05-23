'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROVIDERS,
  TASK_TYPES,
  TASK_MODEL_HINTS,
  configuredProviders,
  detectTaskType,
  providerApiKey,
} = require('../src/orchestration/llm-routing.config');

// ── TASK_TYPES constants ──────────────────────────────────────────

test('TASK_TYPES contains all expected task categories', () => {
  assert.equal(TASK_TYPES.DEEP_REASONING, 'deep_reasoning');
  assert.equal(TASK_TYPES.SPEED, 'speed');
  assert.equal(TASK_TYPES.MULTIMODAL, 'multimodal');
  assert.equal(TASK_TYPES.CODE, 'code');
  assert.equal(TASK_TYPES.EMBEDDINGS, 'embeddings');
  assert.equal(TASK_TYPES.DEFAULT, 'default');
});

test('TASK_TYPES is frozen (immutable)', () => {
  assert.throws(() => { TASK_TYPES.FOO = 'bar'; }, TypeError);
});

// ── PROVIDERS registry ────────────────────────────────────────────

test('PROVIDERS contains all 10 providers', () => {
  const ids = PROVIDERS.map(p => p.id);
  assert.deepEqual(ids, [
    'openrouter', 'anthropic', 'openai', 'google', 'groq',
    'cerebras', 'mistral', 'deepseek', 'voyage', 'jina',
  ]);
});

test('PROVIDERS is frozen (immutable)', () => {
  assert.throws(() => { PROVIDERS.push({}); }, TypeError);
});

test('each provider has required fields', () => {
  for (const p of PROVIDERS) {
    assert.ok(p.id, `provider ${p.id} missing id`);
    assert.ok(p.envKey, `provider ${p.id} missing envKey`);
    assert.ok(Array.isArray(p.models) && p.models.length > 0, `provider ${p.id} missing models`);
    assert.ok(Array.isArray(p.capabilities), `provider ${p.id} missing capabilities`);
    assert.ok(p.score && typeof p.score.quality === 'number', `provider ${p.id} missing score.quality`);
  }
});

test('openrouter has highest priority', () => {
  const or = PROVIDERS.find(p => p.id === 'openrouter');
  const maxPriority = Math.max(...PROVIDERS.map(p => p.priority || 0));
  assert.equal(or.priority, maxPriority);
});

// ── providerApiKey ─────────────────────────────────────────────────

test('providerApiKey returns env value for provider envKey', () => {
  const env = { OPENAI_API_KEY: 'sk-test' };
  const provider = PROVIDERS.find(p => p.id === 'openai');
  assert.equal(providerApiKey(provider, env), 'sk-test');
});

test('providerApiKey returns fallbackEnvKey if primary is missing', () => {
  const env = { GEMINI_API_KEY: 'gemini-fallback' };
  const provider = PROVIDERS.find(p => p.id === 'google');
  assert.equal(providerApiKey(provider, env), 'gemini-fallback');
});

test('providerApiKey prefers primary over fallback', () => {
  const env = { GOOGLE_AI_API_KEY: 'primary', GEMINI_API_KEY: 'fallback' };
  const provider = PROVIDERS.find(p => p.id === 'google');
  assert.equal(providerApiKey(provider, env), 'primary');
});

test('providerApiKey returns empty string when no key configured', () => {
  const env = {};
  const provider = PROVIDERS.find(p => p.id === 'anthropic');
  assert.equal(providerApiKey(provider, env), '');
});

// ── configuredProviders ────────────────────────────────────────────

test('configuredProviders filters to env-configured providers', () => {
  const env = { OPENAI_API_KEY: 'sk-abc', ANTHROPIC_API_KEY: 'sk-ant-xyz' };
  const configured = configuredProviders(env);
  const ids = configured.map(p => p.id).sort();
  assert.deepEqual(ids, ['anthropic', 'openai']);
});

test('configuredProviders returns empty array when no keys set', () => {
  const configured = configuredProviders({});
  assert.deepEqual(configured, []);
});

// ── detectTaskType ─────────────────────────────────────────────────

test('detectTaskType returns EMBEDDINGS when explicitly requested', () => {
  assert.equal(detectTaskType({ prompt: 'hello', requestedCapability: 'embeddings' }), TASK_TYPES.EMBEDDINGS);
});

test('detectTaskType returns MULTIMODAL when image files present', () => {
  assert.equal(detectTaskType({ prompt: 'describe', files: [{ mimeType: 'image/png' }] }), TASK_TYPES.MULTIMODAL);
});

test('detectTaskType returns CODE for code-related prompts', () => {
  assert.equal(detectTaskType({ prompt: 'refactor this code' }), TASK_TYPES.CODE);
  assert.equal(detectTaskType({ prompt: 'debug the typescript function' }), TASK_TYPES.CODE);
  assert.equal(detectTaskType({ prompt: 'create a pull request' }), TASK_TYPES.CODE);
});

test('detectTaskType returns DEEP_REASONING for math/research prompts', () => {
  assert.equal(detectTaskType({ prompt: 'demuestra el teorema' }), TASK_TYPES.DEEP_REASONING);
  assert.equal(detectTaskType({ prompt: 'write a research paper' }), TASK_TYPES.DEEP_REASONING);
  assert.equal(detectTaskType({ prompt: 'razonamiento profundo sobre tesis' }), TASK_TYPES.DEEP_REASONING);
});

test('detectTaskType returns SPEED for fast/quick prompts', () => {
  assert.equal(detectTaskType({ prompt: 'resumen breve de esto' }), TASK_TYPES.SPEED);
  assert.equal(detectTaskType({ prompt: 'solo dame la respuesta rápida' }), TASK_TYPES.SPEED);
});

test('detectTaskType returns DEFAULT for generic prompts', () => {
  assert.equal(detectTaskType({ prompt: 'hello world' }), TASK_TYPES.DEFAULT);
  assert.equal(detectTaskType({ prompt: '' }), TASK_TYPES.DEFAULT);
});

test('detectTaskType handles missing/undefined inputs', () => {
  assert.equal(detectTaskType(), TASK_TYPES.DEFAULT);
  assert.equal(detectTaskType({}), TASK_TYPES.DEFAULT);
  assert.equal(detectTaskType({ prompt: null }), TASK_TYPES.DEFAULT);
});

test('detectTaskType CODE has priority over DEEP_REASONING in ambiguous prompts', () => {
  assert.equal(detectTaskType({ prompt: 'debug the math code' }), TASK_TYPES.CODE);
});

test('detectTaskType handles files with null mimeType', () => {
  assert.equal(detectTaskType({ prompt: 'hello', files: [{ mimeType: null }] }), TASK_TYPES.DEFAULT);
});

// ── TASK_MODEL_HINTS ───────────────────────────────────────────────

test('TASK_MODEL_HINTS has hints for every task type', () => {
  for (const type of Object.values(TASK_TYPES)) {
    assert.ok(Array.isArray(TASK_MODEL_HINTS[type]), `missing hints for ${type}`);
    assert.ok(TASK_MODEL_HINTS[type].length > 0, `empty hints for ${type}`);
  }
});

test('TASK_MODEL_HINTS DEEP_REASONING includes claude-opus and deepseek-reasoner', () => {
  const hints = TASK_MODEL_HINTS.deep_reasoning;
  assert.ok(hints.some(h => h.includes('claude-opus-4-7')));
  assert.ok(hints.some(h => h.includes('deepseek-reasoner')));
});

test('TASK_MODEL_HINTS EMBEDDINGS includes voyage and jina', () => {
  const hints = TASK_MODEL_HINTS.embeddings;
  assert.ok(hints.some(h => h.includes('voyage')));
  assert.ok(hints.some(h => h.includes('jina')));
});

test('TASK_MODEL_HINTS is frozen', () => {
  assert.throws(() => { TASK_MODEL_HINTS.foo = []; }, TypeError);
});

// ── Score bounds ───────────────────────────────────────────────────

test('all provider scores are within 0-1 range', () => {
  for (const p of PROVIDERS) {
    for (const [dim, val] of Object.entries(p.score)) {
      assert.ok(val >= 0 && val <= 1, `${p.id}.${dim} = ${val} out of bounds`);
    }
  }
});
