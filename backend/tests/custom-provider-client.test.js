'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isCustomProvider,
  isCustomConnectionRow,
  isOpenAiCompatibleUrl,
  isLocalVisionModel,
  publicPickerProvider,
  catalogProviderForConnection,
  defaultCustomDisplayName,
  pickCustomConnectionRow,
  shapeConnection,
  resolveCustomConnectionForTurn,
  createCustomProviderClient,
} = require('../src/services/ai/custom-provider-client');

test('isCustomProvider: Custom / Custom API / ollama only', () => {
  assert.equal(isCustomProvider('Custom'), true);
  assert.equal(isCustomProvider('custom'), true);
  assert.equal(isCustomProvider('Custom API'), true);
  assert.equal(isCustomProvider('Ollama'), true);
  assert.equal(isCustomProvider('DeepSeek'), false);
  assert.equal(isCustomProvider('OpenAI'), false);
  assert.equal(isCustomProvider('OpenRouter'), false);
  assert.equal(isCustomProvider('Sira'), false);
  assert.equal(isCustomProvider(''), false);
});

test('isOpenAiCompatibleUrl: /v1 base, not cloud-provider inference', () => {
  assert.equal(isOpenAiCompatibleUrl('http://lenovo.local:11434/v1'), true);
  assert.equal(isOpenAiCompatibleUrl('http://lenovo.local:11434/v1/'), true);
  assert.equal(isOpenAiCompatibleUrl('http://lenovo.local:11434'), false);
  assert.equal(isOpenAiCompatibleUrl('https://api.openai.com/v1'), true);
});

test('isCustomConnectionRow: custom key or unknown /v1 host; never DeepSeek/OpenAI', () => {
  assert.equal(isCustomConnectionRow({ providerKey: 'custom', url: 'http://10.0.0.8:11434/v1' }), true);
  assert.equal(isCustomConnectionRow({ providerKey: 'local-llm', url: 'http://10.0.0.8:11434/v1' }), true);
  assert.equal(isCustomConnectionRow({ providerKey: 'openai', url: 'https://api.openai.com/v1' }), false);
  assert.equal(isCustomConnectionRow({ providerKey: 'deepseek', url: 'https://api.deepseek.com/v1' }), false);
  assert.equal(isCustomConnectionRow({ providerKey: 'openrouter', url: 'https://openrouter.ai/api/v1' }), false);
});

test('publicPickerProvider hides Ollama / HuggingFace / Custom API', () => {
  assert.equal(publicPickerProvider('Custom'), 'Sira');
  assert.equal(publicPickerProvider('Custom API'), 'Sira');
  assert.equal(publicPickerProvider('Ollama'), 'Sira');
  assert.equal(publicPickerProvider('HuggingFace'), 'Sira');
  assert.equal(publicPickerProvider('Hugging Face'), 'Sira');
  assert.equal(publicPickerProvider('DeepSeek'), 'DeepSeek');
  assert.equal(publicPickerProvider('OpenAI'), 'OpenAI');
});

test('catalogProviderForConnection canonicalises custom → Custom', () => {
  assert.equal(catalogProviderForConnection('custom', 'Ollama local'), 'Custom');
  assert.equal(catalogProviderForConnection('openai', 'OpenAI'), 'OpenAI');
});

test('defaultCustomDisplayName: moondream → Sira Mini without a vendor display_name', () => {
  assert.equal(defaultCustomDisplayName('moondream', ''), 'Sira Mini');
  assert.equal(defaultCustomDisplayName('moondream:latest', 'Moondream'), 'Sira Mini');
  assert.equal(defaultCustomDisplayName('moondream', 'Sira Mini'), 'Sira Mini');
  assert.equal(defaultCustomDisplayName('llama3.2', 'Llama 3.2'), 'Llama 3.2');
});

test('isLocalVisionModel: moondream / llava are multimodal', () => {
  assert.equal(isLocalVisionModel('moondream'), true);
  assert.equal(isLocalVisionModel('moondream:latest'), true);
  assert.equal(isLocalVisionModel('llava'), true);
  assert.equal(isLocalVisionModel('deepseek-v4-flash'), false);
  assert.equal(isLocalVisionModel('llama-3.1-8b'), false);
});

test('createCustomProviderClient uses connection.url, never api.openai.com', () => {
  const captured = [];
  class FakeOpenAI {
    constructor(opts) {
      captured.push(opts);
      this.opts = opts;
    }
  }

  const client = createCustomProviderClient(
    { url: 'http://10.0.0.8:11434/v1/', apiKey: null, authType: 'None' },
    { OpenAI: FakeOpenAI },
  );

  assert.equal(client.opts.baseURL, 'http://10.0.0.8:11434/v1');
  assert.notEqual(client.opts.baseURL, 'https://api.openai.com/v1');
  assert.ok(!String(client.opts.baseURL).includes('api.openai.com'));
  assert.equal(client.opts.apiKey, 'local');
  assert.equal(captured.length, 1);
});

test('createCustomProviderClient: Bearer key is forwarded; None does not decrypt', () => {
  class FakeOpenAI {
    constructor(opts) { this.opts = opts; }
  }
  const withKey = createCustomProviderClient(
    { url: 'http://127.0.0.1:11434/v1', apiKey: 'not-a-secret-placeholder', authType: 'Bearer' },
    { OpenAI: FakeOpenAI },
  );
  assert.equal(withKey.opts.apiKey, 'not-a-secret-placeholder');
  assert.equal(withKey.opts.baseURL, 'http://127.0.0.1:11434/v1');
});

test('pickCustomConnectionRow prefers modelIds match over newest catch-all', () => {
  const rows = [
    { id: 'newer', providerKey: 'custom', url: 'http://a:11434/v1', modelIds: ['other'] },
    { id: 'match', providerKey: 'custom', url: 'http://b:11434/v1', modelIds: ['moondream'] },
  ];
  const picked = pickCustomConnectionRow(rows, 'moondream:latest');
  assert.equal(picked.id, 'match');
  assert.equal(picked.url, 'http://b:11434/v1');
});

test('shapeConnection: auth None drops the key even if a leftover blob exists', () => {
  const shaped = shapeConnection({
    id: 'c1',
    url: 'http://10.0.0.8:11434/v1/',
    authType: 'None',
    apiKey: 'enc:v1:should-not-be-used',
  });
  assert.equal(shaped.url, 'http://10.0.0.8:11434/v1');
  assert.equal(shaped.apiKey, null);
  assert.equal(shaped.authType, 'None');
});

test('resolveCustomConnectionForTurn: Custom catalog row + enabled connection.url', async () => {
  const prisma = {
    aiModel: {
      findUnique: async ({ where }) => (
        where.name === 'moondream'
          ? { name: 'moondream', displayName: 'Sira Mini', provider: 'Custom', isActive: true, type: 'TEXT' }
          : null
      ),
    },
    adminConnection: {
      findMany: async () => ([
        {
          id: 'conn-custom',
          url: 'http://10.0.0.8:11434/v1',
          providerKey: 'custom',
          apiKey: null,
          authType: 'None',
          modelIds: [],
          headers: null,
          enabled: true,
          updatedAt: new Date('2026-08-27'),
        },
      ]),
    },
  };

  const resolved = await resolveCustomConnectionForTurn({
    provider: 'Sira',
    model: 'moondream',
    prisma,
  });
  assert.equal(resolved.isCustom, true);
  assert.ok(resolved.connection);
  assert.equal(resolved.connection.url, 'http://10.0.0.8:11434/v1');
  assert.equal(resolved.connection.apiKey, null);
  assert.equal(resolved.catalog.displayName, 'Sira Mini');
});

test('resolveCustomConnectionForTurn: DeepSeek stays off the custom path', async () => {
  const prisma = {
    aiModel: {
      findUnique: async ({ where }) => (
        where.name === 'deepseek-v4-flash'
          ? { name: 'deepseek-v4-flash', displayName: 'Sira Rápido', provider: 'DeepSeek', isActive: true, type: 'TEXT' }
          : null
      ),
    },
    adminConnection: {
      findMany: async () => ([
        {
          id: 'conn-custom',
          url: 'http://10.0.0.8:11434/v1',
          providerKey: 'custom',
          apiKey: null,
          authType: 'None',
          modelIds: [],
          enabled: true,
          updatedAt: new Date(),
        },
      ]),
    },
  };

  const resolved = await resolveCustomConnectionForTurn({
    provider: 'DeepSeek',
    model: 'deepseek-v4-flash',
    prisma,
  });
  assert.equal(resolved.isCustom, false);
  assert.equal(resolved.connection, null);
});

test('ai.js wires Custom into createProviderClient / generate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /custom-provider-client/, 'route must require the custom connection helper');
  assert.match(src, /createCustomProviderClient/, 'createProviderClient must call createCustomProviderClient');
  assert.match(src, /resolveCustomConnectionForTurn/, 'generate must resolve the connection row at request time');
  assert.match(src, /customConnection/, 'request-aware client must accept the resolved connection');
  assert.doesNotMatch(src, /OPENAI_BASE_URL/, 'must not stuff Custom into OPENAI_BASE_URL');
});
