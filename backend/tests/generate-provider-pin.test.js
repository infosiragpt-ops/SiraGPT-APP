'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  inferProviderFromModelId,
  resolveGenerateProvider,
  providerConnectionReady,
  CONNECTION_UNAVAILABLE_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
} = require('../src/services/ai/provider-inference');
const service = require('../src/services/ai-service');

const aiRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');


const LIVE = [
  { model: 'sira-mini', provider: 'Custom' },
  { model: 'google/gemini-3.5-flash', provider: 'Gemini' },
  { model: 'gemini-3.5-flash', provider: 'Gemini' },
  { model: 'anthropic/claude-sonnet-5', provider: 'Anthropic' },
  { model: 'anthropic/claude-fable-5', provider: 'Anthropic' },
  { model: 'claude-fable-5', provider: 'Anthropic' },
  { model: 'gpt-5.6-terra', provider: 'OpenAI' },
  { model: 'openai/gpt-5.6-terra', provider: 'OpenAI' },
  { model: 'gpt-6-sol', provider: 'OpenAI' },
  { model: 'moonshotai/kimi-k2.6', provider: 'Kimi' },
  { model: 'moonshotai/kimi-k2.7-code', provider: 'Kimi' },
  { model: 'x-ai/grok-4', provider: 'xAI' },
  { model: 'x-ai/grok-4.5', provider: 'xAI' },
  { model: 'x-ai/grok-4.6', provider: 'xAI' },
  { model: 'grok-4.6', provider: 'xAI' },
  { model: 'Grok 4.5', provider: 'xAI' },
  { model: 'Grok 4.6', provider: 'xAI' },
  { model: 'muse-spark-1.2-contributor', provider: 'Meta' },
  { model: 'muse-spark-1.2', provider: 'Meta' },
];

test('inferProviderFromModelId: live catalog families hit their own API', () => {
  for (const row of LIVE) {
    assert.equal(
      inferProviderFromModelId(row.model),
      row.provider,
      `expected ${row.provider} for "${row.model}"`,
    );
  }
});

test('resolveGenerateProvider: OpenRouter mixer label cannot steal first-party models', () => {
  assert.equal(resolveGenerateProvider('OpenRouter', 'google/gemini-3.5-flash'), 'Gemini');
  assert.equal(resolveGenerateProvider('OpenRouter', 'anthropic/claude-sonnet-5'), 'Anthropic');
  assert.equal(resolveGenerateProvider('OpenRouter', 'gpt-5.6-terra'), 'OpenAI');
  assert.equal(resolveGenerateProvider('OpenRouter', 'moonshotai/kimi-k2.6'), 'Kimi');
  assert.equal(resolveGenerateProvider('OpenRouter', 'sira-mini'), 'Custom');
  assert.equal(resolveGenerateProvider('DeepSeek', 'google/gemini-3.5-flash'), 'Gemini');
  assert.equal(resolveGenerateProvider('Anthropic', 'anthropic/claude-fable-5'), 'Anthropic');
  assert.equal(resolveGenerateProvider('Kimi', 'moonshotai/kimi-k2.7-code'), 'Kimi');
  assert.equal(resolveGenerateProvider('OpenRouter', 'x-ai/grok-4'), 'xAI');
  assert.equal(resolveGenerateProvider('DeepSeek', 'Grok 4.5'), 'xAI');
});

test('ai-service providerForModel / normalizeChatProvider match the same first-party map', () => {
  for (const row of LIVE) {
    assert.equal(service.__test.providerForModel(row.model), row.provider);
    assert.equal(service.__test.normalizeChatProvider('OpenRouter', row.model), row.provider);
  }
  assert.notEqual(service.__test.normalizeChatProvider('Anthropic', 'claude-sonnet-5'), 'OpenRouter');
});

test('user-selected catalog models never walk the fallback chain', () => {
  for (const row of LIVE) {
    assert.equal(service.__test.isPinnedUserGenerate(row.provider, row.model), true);
    assert.deepEqual(service.__test.getFallbackChain(row.provider, row.model), []);
  }
  assert.equal(service.__test.isPinnedUserGenerate('DeepSeek', 'deepseek-v4-flash'), true);
  assert.deepEqual(service.__test.getFallbackChain('DeepSeek', 'deepseek-v4-flash'), []);
  assert.deepEqual(service.__test.getFallbackChain('OpenRouter', 'x-ai/grok-4.20'), []);
  const leftover = service.__test.getFallbackChain('OpenRouter');
  assert.ok(Array.isArray(leftover));
});

test('boot audit lists Kimi when MOONSHOT/KIMI keys are missing', () => {
  assert.match(aiRoute, /name: 'Kimi'/);
  assert.match(aiRoute, /MOONSHOT_API_KEY \(or KIMI_API_KEY\)/);
});

test('missing first-party key is provider-unavailable, not a vendor swap', () => {
  assert.equal(CONNECTION_UNAVAILABLE_MESSAGE, 'Conexión no disponible');
  assert.match(PROVIDER_UNAVAILABLE_MESSAGE, /Este modelo no está disponible/);
  assert.doesNotMatch(PROVIDER_UNAVAILABLE_MESSAGE, /\/conexiones|DeepSeek|OpenRouter|xAI|model_id/i);
  const env = {};
  assert.equal(providerConnectionReady('Gemini', env), false);
  assert.equal(providerConnectionReady('Anthropic', env), false);
  assert.equal(providerConnectionReady('OpenAI', env), false);
  assert.equal(providerConnectionReady('Kimi', env), false);
  assert.equal(providerConnectionReady('xAI', env), false);
  assert.equal(providerConnectionReady('Gemini', { GEMINI_API_KEY: 'x' }), true);
  assert.equal(providerConnectionReady('Kimi', { MOONSHOT_API_KEY: 'x' }), true);
  assert.equal(providerConnectionReady('xAI', { XAI_API_KEY: 'x' }), true);
});

test('generate route pins the picker model and fails closed without a connection', () => {
  assert.match(aiRoute, /resolveGenerateProvider\(provider, model\)/);
  assert.match(aiRoute, /honorPickerModel\(model, \{ provider \}\)/);
  assert.match(aiRoute, /providerConnectionReady\(actualProvider\)/);
  assert.match(aiRoute, /PROVIDER_UNAVAILABLE_MESSAGE/);
  assert.match(aiRoute, /error: 'provider_unavailable'/);
  assert.match(aiRoute, /&& !honorUserModel/);
});

test('Effort Extra on Mini must not switch APIs', () => {
  assert.match(
    aiRoute,
    /const honorUserModel = String\(model \|\| ''\)\.trim\(\)\.length > 0/,
  );
  assert.match(aiRoute, /&& !honorUserModel/);
  assert.equal(resolveGenerateProvider('Custom', 'sira-mini'), 'Custom');
  assert.deepEqual(service.__test.getFallbackChain('Custom', 'sira-mini'), []);
});

test('normalizeModelForProvider strips native prefixes and never adds anthropic/ for OpenRouter', () => {
  assert.equal(service.__test.normalizeModelForProvider('Anthropic', 'anthropic/claude-fable-5'), 'claude-fable-5');
  assert.equal(service.__test.normalizeModelForProvider('Kimi', 'moonshotai/kimi-k2.6'), 'kimi-k2.6');
  assert.equal(service.__test.normalizeModelForProvider('Gemini', 'google/gemini-3.5-flash'), 'gemini-3.5-flash');
  assert.equal(service.__test.normalizeModelForProvider('OpenAI', 'openai/gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(service.__test.normalizeModelForProvider('OpenAI', 'openai/gpt-6-sol'), 'gpt-6-sol');
  assert.equal(service.__test.normalizeModelForProvider('OpenRouter', 'claude-sonnet-4.5'), 'claude-sonnet-4.5');
});

test('getClient factory wires Anthropic / Kimi / xAI — not OpenRouter or OpenAI fallthrough', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai-service.js'), 'utf8');
  assert.match(src, /createAnthropicStreamingClient/);
  assert.match(src, /createMoonshotClient/);
  assert.match(src, /createXaiClient/);
  assert.match(src, /api\.meta\.ai/);
  assert.doesNotMatch(src, /createAnthropicOpenAIAdapter/);

  const prev = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    META_API_KEY: process.env.META_API_KEY,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    LLAMA_API_KEY: process.env.LLAMA_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIRA_ANTHROPIC_API_KEY;
  try {
    assert.throws(() => service.getClient('Anthropic'), (err) => {
      assert.match(String(err && err.message), /Este modelo no está disponible/);
      assert.doesNotMatch(String(err && err.message), /DeepSeek|OpenRouter/);
      return true;
    });
    process.env.MOONSHOT_API_KEY = 'kimi-test-key';
    const kimi = service.getClient('Kimi');
    assert.ok(kimi);
    assert.match(String(kimi.baseURL || ''), /moonshot/i);
    process.env.XAI_API_KEY = 'xai-test-key';
    const xai = service.getClient('xAI');
    assert.ok(xai);
    assert.match(String(xai.baseURL || ''), /x\.ai/i);
    process.env.META_API_KEY = 'meta-test-key';
    const meta = service.getClient('Meta');
    assert.ok(meta);
    assert.match(String(meta.baseURL || ''), /api\.meta\.ai/i);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Failover rungs (billing-failover DEFAULT_ORDER: DeepSeek → Cerebras →
// Gemini → Groq → Mistral → …) used to fall through to api.openai.com.
test('getClient sends Cerebras / Groq / Mistral / Z.ai to their own hosts, never api.openai.com', () => {
  const names = ['CEREBRAS_API_KEY', 'CEREBRAS_BASE_URL', 'GROQ_API_KEY', 'GROQ_BASE_URL', 'MISTRAL_API_KEY', 'MISTRAL_BASE_URL', 'ZAI_API_KEY', 'ZAI_BASE_URL'];
  const prev = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    process.env.CEREBRAS_API_KEY = 'cb-test-key';
    process.env.GROQ_API_KEY = 'gq-test-key';
    process.env.MISTRAL_API_KEY = 'ms-test-key';
    process.env.ZAI_API_KEY = 'zai-test-key';
    const expected = [
      ['Cerebras', /api\.cerebras\.ai/, 'cb-test-key'],
      ['Groq', /api\.groq\.com\/openai/, 'gq-test-key'],
      ['Mistral', /api\.mistral\.ai/, 'ms-test-key'],
      ['Z.ai', /api\.z\.ai/, 'zai-test-key'],
      ['ZAI', /api\.z\.ai/, 'zai-test-key'],
    ];
    for (const [provider, host, key] of expected) {
      const client = service.getClient(provider);
      assert.match(String(client.baseURL || ''), host, provider);
      assert.doesNotMatch(String(client.baseURL || ''), /api\.openai\.com/, provider);
      assert.equal(client.apiKey, key, `${provider} uses its own key`);
    }
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('getClient without the provider key throws the 503 «Conexión no disponible», never reuses the OpenAI key', () => {
  const names = ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'CEREBRAS_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY'];
  const prev = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
  try {
    for (const provider of ['Gemini', 'OpenRouter', 'DeepSeek', 'Cerebras', 'Groq', 'Mistral', 'Z.ai']) {
      assert.throws(() => service.getClient(provider), (err) => {
        assert.equal(err.code, 'PROVIDER_CONNECTION_UNAVAILABLE', provider);
        assert.equal(err.status, 503, provider);
        assert.equal(err.message, PROVIDER_UNAVAILABLE_MESSAGE);
        assert.doesNotMatch(String(err.message), /sk-|OpenRouter|DeepSeek/);
        return true;
      }, provider);
    }
    // The Gemini alias key is enough.
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-alias-key';
    assert.equal(service.getClient('Gemini').apiKey, 'g-alias-key');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Mini short_chitchat skips test-time-compute and slims the system prompt', () => {
  assert.match(aiRoute, /generateLog\.info\(\s*'reasoning\.test_time_compute_skipped'/);
  assert.match(aiRoute, /req\._miniShortChitchat/);
  assert.match(aiRoute, /MINI_SHORT_CHITCHAT_SYSTEM/);
  assert.match(aiRoute, /mini-short-chitchat/);
  const { isShortChitchatPrompt } = require('../src/services/agents/intent-triage');
  assert.equal(isShortChitchatPrompt('Hola'), true);
  assert.equal(isShortChitchatPrompt('hola necesito el reporte'), false);
});

test('trivial turns skip Extra/Max effort so greetings stay fast', () => {
  assert.match(aiRoute, /generateLog\.info\(\s*'reasoning\.trivial_kept_direct'/);
  assert.match(aiRoute, /applyTrivialTurnGuards\(req, prompt\)/);
  assert.match(aiRoute, /generateLog\.info\(\s*'reasoning\.test_time_compute_skipped'/);
});

test('duplicate Mini replay emits text_delta and omits raw model_id', () => {
  assert.match(aiRoute, /type: 'text_delta', content/);
  assert.match(aiRoute, /never leak raw model_id/);
  assert.match(aiRoute, /X-Model-Actual', branded/);
});

test('createProviderClient uses the streaming Anthropic client, not the non-stream adapter', () => {
  assert.match(aiRoute, /createAnthropicStreamingClient\(\)/);
  assert.doesNotMatch(aiRoute, /createAnthropicOpenAIAdapter/);
});
