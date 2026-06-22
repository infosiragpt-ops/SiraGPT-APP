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

test('inferProviderFromModelId: Groq -versatile vs bare-llama Cerebras (FlashGPT)', () => {
  assert.equal(inferProviderFromModelId('llama-3.3-70b-versatile'), 'Groq');
  // Bare FlashGPT/Cerebras model ids route to Cerebras (not OpenAI, which
  // doesn't serve them) — createProviderClient('Cerebras') gates on the key.
  assert.equal(inferProviderFromModelId('llama-3.1-8b'), 'Cerebras');
  assert.equal(inferProviderFromModelId('llama-3.1-70b'), 'Cerebras');
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

test('inferProviderFromModelId: hostile non-string inputs never throw → OpenAI default', () => {
  // Null-prototype object — String() throws "Cannot convert object to primitive value".
  assert.equal(inferProviderFromModelId(Object.create(null)), 'OpenAI');
  // toString that throws.
  assert.equal(
    inferProviderFromModelId({ toString() { throw new Error('boom'); } }),
    'OpenAI'
  );
  // Plain non-strings coerce safely to the fallback.
  assert.equal(inferProviderFromModelId(123), 'OpenAI');
  assert.equal(inferProviderFromModelId(true), 'OpenAI');
  assert.equal(inferProviderFromModelId({}), 'OpenAI');
});

test('isDirectDeepSeekModel: hostile non-string inputs never throw', () => {
  assert.equal(isDirectDeepSeekModel(Object.create(null)), false);
  assert.equal(isDirectDeepSeekModel({ toString() { throw new Error('boom'); } }), false);
  assert.equal(isDirectDeepSeekModel(42), false);
});

test('inferProviderFromModelId: surrounding whitespace infers same as clean form', () => {
  assert.equal(inferProviderFromModelId('  claude-opus-4-7  '), 'Anthropic');
  assert.equal(inferProviderFromModelId('\tmistral-large-latest\n'), 'Mistral');
  assert.equal(inferProviderFromModelId(' codestral-latest'), 'Mistral');
  assert.equal(inferProviderFromModelId('llama-3.3-70b-versatile  '), 'Groq');
  assert.equal(inferProviderFromModelId('  deepseek-chat '), 'DeepSeek');
  assert.equal(inferProviderFromModelId('  gemini-2.5-pro '), 'Gemini');
  assert.equal(inferProviderFromModelId(' anthropic/claude-opus-4.7 '), 'OpenRouter');
});

test('inferProviderFromModelId: leading/trailing slashes infer same as clean form', () => {
  assert.equal(inferProviderFromModelId('/claude-sonnet-4-6'), 'Anthropic');
  assert.equal(inferProviderFromModelId('/mistral-large-latest'), 'Mistral');
  assert.equal(inferProviderFromModelId('/deepseek-reasoner'), 'DeepSeek');
  assert.equal(inferProviderFromModelId('llama-3.1-70b-versatile/'), 'Groq');
  assert.equal(inferProviderFromModelId('claude-haiku-4-5/'), 'Anthropic');
  // A stray leading slash must NOT trip the "/gpt-oss" OpenRouter slug rule:
  // the clean form "gpt-oss-120b" is the bare FlashGPT/Cerebras id.
  assert.equal(inferProviderFromModelId('/gpt-oss-120b'), 'Cerebras');
  // Internal slashes (real OpenRouter slugs) are preserved:
  assert.equal(inferProviderFromModelId('anthropic/claude-opus-4.7/'), 'OpenRouter');
  assert.equal(inferProviderFromModelId('/openai/gpt-oss-120b'), 'OpenRouter');
});

test('inferProviderFromModelId: mixed case + decoration combine correctly', () => {
  assert.equal(inferProviderFromModelId('  CLAUDE-OPUS-4-7 '), 'Anthropic');
  assert.equal(inferProviderFromModelId(' /MISTRAL-LARGE-LATEST'), 'Mistral');
  assert.equal(inferProviderFromModelId('DeepSeek-Chat  '), 'DeepSeek');
});

test('inferProviderFromModelId: whitespace-only / slash-only ids → OpenAI default', () => {
  assert.equal(inferProviderFromModelId('   '), 'OpenAI');
  assert.equal(inferProviderFromModelId('///'), 'OpenAI');
  assert.equal(inferProviderFromModelId(' / '), 'OpenAI');
});

test('inferProviderFromModelId: Z.ai (GLM) and Kimi (Moonshot) direct ids', () => {
  // Bare ids route to the direct provider…
  assert.equal(inferProviderFromModelId('glm-4.6'), 'Z.ai');
  assert.equal(inferProviderFromModelId('glm-4-air'), 'Z.ai');
  assert.equal(inferProviderFromModelId('kimi-k2'), 'Kimi');
  assert.equal(inferProviderFromModelId('moonshot-v1-128k'), 'Kimi');
  // …while aggregator slugs still go through OpenRouter.
  assert.equal(inferProviderFromModelId('z-ai/glm-4.6'), 'OpenRouter');
  assert.equal(inferProviderFromModelId('moonshotai/kimi-k2'), 'OpenRouter');
});

test('listKnownProviders / KNOWN_PROVIDERS: stable canonical set', () => {
  const list = listKnownProviders();
  assert.ok(list.includes('Gemini'));
  assert.ok(list.includes('OpenAI'));
  // Snapshot must equal KNOWN_PROVIDERS (defensive copy).
  assert.deepEqual(list, [...KNOWN_PROVIDERS]);
  list.push('Mutant'); // verify defensive copy doesn't leak
  assert.equal(KNOWN_PROVIDERS.includes('Mutant'), false);
});
