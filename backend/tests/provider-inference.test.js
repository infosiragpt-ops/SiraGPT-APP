'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferProviderFromModelId,
  isDirectDeepSeekModel,
  listKnownProviders,
  KNOWN_PROVIDERS,
} = require('../src/services/ai/provider-inference');

test('isDirectDeepSeekModel: matches the deepseek-v* / deepseek-chat / deepseek-reasoner shapes only', () => {
  assert.equal(isDirectDeepSeekModel('deepseek-v4-flash'), true);
  assert.equal(isDirectDeepSeekModel('deepseek-v4-pro'), true);
  assert.equal(isDirectDeepSeekModel('deepseek-chat'), true);
  assert.equal(isDirectDeepSeekModel('deepseek-reasoner'), true);
  assert.equal(isDirectDeepSeekModel('  deepseek-v3  '), true);
  // Not a direct-API id — these go through OpenRouter:
  assert.equal(isDirectDeepSeekModel('deepseek/deepseek-r1'), false);
  assert.equal(isDirectDeepSeekModel('openrouter/deepseek-v4'), false);
  assert.equal(isDirectDeepSeekModel(''), false);
  assert.equal(isDirectDeepSeekModel(null), false);
});

test('inferProviderFromModelId: empty / null / undefined → OpenAI (safe default)', () => {
  assert.equal(inferProviderFromModelId(''), 'OpenAI');
  assert.equal(inferProviderFromModelId(null), 'OpenAI');
  assert.equal(inferProviderFromModelId(undefined), 'OpenAI');
});

test('inferProviderFromModelId: DeepSeek direct-API ids', () => {
  assert.equal(inferProviderFromModelId('deepseek-v4-flash'), 'DeepSeek');
  assert.equal(inferProviderFromModelId('deepseek-v4-pro'), 'DeepSeek');
  assert.equal(inferProviderFromModelId('deepseek-reasoner'), 'DeepSeek');
});

test('inferProviderFromModelId: OpenRouter slug prefixes (case-insensitive)', () => {
  const cases = [
    'anthropic/claude-sonnet-4.6',
    'x-ai/grok-4',
    'openrouter/auto',
    'meta-llama/llama-3.3-70b',
    'deepseek/deepseek-r1',
    'openai/gpt-oss-120b',
    'moonshotai/kimi-k2.6',
    'qwen/qwen-2.5-72b',
    'mistralai/mistral-large',
    'cohere/command-r-plus',
    'nousresearch/hermes-3',
  ];
  for (const id of cases) {
    assert.equal(inferProviderFromModelId(id), 'OpenRouter', `expected OpenRouter for "${id}"`);
    // Case-insensitive
    assert.equal(inferProviderFromModelId(id.toUpperCase()), 'OpenRouter', `expected OpenRouter for "${id.toUpperCase()}"`);
  }
});

test('inferProviderFromModelId: Google Gemini family', () => {
  assert.equal(inferProviderFromModelId('gemini-2.5-pro'), 'Gemini');
  assert.equal(inferProviderFromModelId('gemini-2.5-flash'), 'Gemini');
  assert.equal(inferProviderFromModelId('imagen-3'), 'Gemini');
});

test('inferProviderFromModelId: Free IA (Cerebras Llama 3.1 family)', () => {
  assert.equal(inferProviderFromModelId('llama-3.1-8b'), 'Cerebras');
  assert.equal(inferProviderFromModelId('llama-3.1-70b'), 'Cerebras');
  assert.equal(inferProviderFromModelId('llama3.1-8b'), 'Cerebras');
  assert.equal(inferProviderFromModelId('cerebras:llama-3.1-8b'), 'Cerebras');
  // The 3.3-70b SKU also routes to Cerebras when bare (Groq picks it
  // up only with the -versatile suffix).
  assert.equal(inferProviderFromModelId('llama-3.3-70b'), 'Cerebras');
});

test('inferProviderFromModelId: Anthropic direct (bare claude-*)', () => {
  assert.equal(inferProviderFromModelId('claude-opus-4-7'), 'Anthropic');
  assert.equal(inferProviderFromModelId('claude-sonnet-4-6'), 'Anthropic');
  assert.equal(inferProviderFromModelId('claude-haiku-4-5'), 'Anthropic');
  // But slug-prefixed claude goes through OpenRouter:
  assert.equal(inferProviderFromModelId('anthropic/claude-opus-4.7'), 'OpenRouter');
});

test('inferProviderFromModelId: Groq direct (-versatile suffix)', () => {
  assert.equal(inferProviderFromModelId('llama-3.3-70b-versatile'), 'Groq');
  assert.equal(inferProviderFromModelId('llama-3.1-70b-versatile'), 'Groq');
});

test('inferProviderFromModelId: Mistral direct (bare mistral-*/codestral-*)', () => {
  assert.equal(inferProviderFromModelId('mistral-large-latest'), 'Mistral');
  assert.equal(inferProviderFromModelId('mistral-small-latest'), 'Mistral');
  assert.equal(inferProviderFromModelId('codestral-latest'), 'Mistral');
});

test('inferProviderFromModelId: unknown ids fall back to OpenAI (safe)', () => {
  assert.equal(inferProviderFromModelId('gpt-5'), 'OpenAI');
  assert.equal(inferProviderFromModelId('gpt-4o-mini'), 'OpenAI');
  assert.equal(inferProviderFromModelId('something-totally-new'), 'OpenAI');
});

test('listKnownProviders / KNOWN_PROVIDERS: stable canonical set', () => {
  const list = listKnownProviders();
  assert.ok(list.includes('Cerebras'));
  assert.ok(list.includes('Gemini'));
  assert.ok(list.includes('OpenAI'));
  // Snapshot must equal KNOWN_PROVIDERS (defensive copy).
  assert.deepEqual(list, [...KNOWN_PROVIDERS]);
  list.push('Mutant'); // verify defensive copy doesn't leak
  assert.equal(KNOWN_PROVIDERS.includes('Mutant'), false);
});
