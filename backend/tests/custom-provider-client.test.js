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
  isSiraMiniAlias,
  publicPickerProvider,
  publicPickerModel,
  catalogProviderForConnection,
  defaultCustomDisplayName,
  rewriteCustomChatModel,
  ollamaNativeChatUrl,
  buildOllamaNativeChatBody,
  pickCustomConnectionRow,
  shapeConnection,
  resolveCustomConnectionForTurn,
  createCustomProviderClient,
  collapseSiraMiniRows,
  resolveSiraMiniUpstreamId,
  SIRA_MINI_DEFAULT_BASE_URL,
  SIRA_MINI_UPSTREAM_DEFAULT,
  SIRA_MINI_PUBLIC_NAME,
  SIRA_MINI_NATIVE_CHAT_PATH,
  SIRA_MINI_KEEP_ALIVE,
  SIRA_MINI_THINK,
} = require('../src/services/ai/custom-provider-client');

test('isCustomProvider: Custom / Custom API / ollama only', () => {
  assert.equal(isCustomProvider('Custom'), true);
  assert.equal(isCustomProvider('custom'), true);
  assert.equal(isCustomProvider('Custom API'), true);
  assert.equal(isCustomProvider('Ollama'), true);
  assert.equal(isCustomProvider('HuggingFace'), true);
  assert.equal(isCustomProvider('DeepSeek'), false);
  assert.equal(isCustomProvider('OpenAI'), false);
  assert.equal(isCustomProvider('OpenRouter'), false);
  assert.equal(isCustomProvider('Sira'), false);
  assert.equal(isCustomProvider(''), false);
});

test('isOpenAiCompatibleUrl: /v1 base, not cloud-provider inference', () => {
  assert.equal(isOpenAiCompatibleUrl('http://siragpt-ollama:11434/v1'), true);
  assert.equal(isOpenAiCompatibleUrl('http://siragpt-ollama:11434/v1/'), true);
  assert.equal(isOpenAiCompatibleUrl('http://siragpt-ollama:11434'), false);
  assert.equal(isOpenAiCompatibleUrl('https://api.openai.com/v1'), true);
});

test('isSiraMiniAlias: public + upstream ids', () => {
  assert.equal(isSiraMiniAlias('sira-mini'), true);
  assert.equal(isSiraMiniAlias('Sira Mini'), true);
  assert.equal(isSiraMiniAlias('SiraGPT Mini'), true);
  assert.equal(isSiraMiniAlias('moondream'), true);
  assert.equal(isSiraMiniAlias('moondream:latest'), true);
  assert.equal(isSiraMiniAlias('gemma4'), true);
  assert.equal(isSiraMiniAlias('gemma4:26b'), true);
  assert.equal(isSiraMiniAlias('deepseek-v4-flash'), false);
  assert.equal(isSiraMiniAlias('google/gemma-3-27b-it'), false);
});

test('SIRA_MINI_UPSTREAM_ID defaults to sira-mini and honors env override', () => {
  const previous = process.env.SIRA_MINI_UPSTREAM_ID;
  try {
    delete process.env.SIRA_MINI_UPSTREAM_ID;
    assert.equal(SIRA_MINI_UPSTREAM_DEFAULT, 'sira-mini');
    assert.equal(resolveSiraMiniUpstreamId({}), 'sira-mini');
    assert.equal(resolveSiraMiniUpstreamId({ SIRA_MINI_UPSTREAM_ID: '' }), 'sira-mini');
    assert.equal(rewriteCustomChatModel('sira-mini', {}), 'sira-mini');
    assert.equal(rewriteCustomChatModel('moondream', {}), 'sira-mini');
    assert.equal(rewriteCustomChatModel('gemma4:26b', {}), 'sira-mini');
    assert.equal(resolveSiraMiniUpstreamId({ SIRA_MINI_UPSTREAM_ID: 'gemma4:26b' }), 'gemma4:26b');
    assert.equal(rewriteCustomChatModel('sira-mini', { SIRA_MINI_UPSTREAM_ID: 'gemma4:26b' }), 'gemma4:26b');
    process.env.SIRA_MINI_UPSTREAM_ID = 'moondream:latest';
    assert.equal(resolveSiraMiniUpstreamId(), 'moondream:latest');
    assert.equal(rewriteCustomChatModel('sira-mini'), 'moondream:latest');
    assert.equal(isSiraMiniAlias('moondream:latest'), true);
  } finally {
    if (previous === undefined) delete process.env.SIRA_MINI_UPSTREAM_ID;
    else process.env.SIRA_MINI_UPSTREAM_ID = previous;
  }
});

test('isCustomConnectionRow: custom key or unknown /v1 host; never DeepSeek/OpenAI', () => {
  assert.equal(isCustomConnectionRow({ providerKey: 'custom', url: 'http://siragpt-ollama:11434/v1' }), true);
  assert.equal(isCustomConnectionRow({ providerKey: 'local-llm', url: 'http://siragpt-ollama:11434/v1' }), true);
  assert.equal(isCustomConnectionRow({ providerKey: 'openai', url: 'https://api.openai.com/v1' }), false);
  assert.equal(isCustomConnectionRow({ providerKey: 'deepseek', url: 'https://api.deepseek.com/v1' }), false);
  assert.equal(isCustomConnectionRow({ providerKey: 'openrouter', url: 'https://openrouter.ai/api/v1' }), false);
  assert.equal(isCustomConnectionRow({ providerKey: 'meta', url: 'https://api.meta.ai/v1' }), false);
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

test('publicPickerModel: DeepSeek V4 Flash/Pro display as Sira Rápido / Sira Pro', () => {
  const flash = publicPickerModel({
    name: 'deepseek-v4-flash',
    displayName: 'Deepseek V4 Flash',
    provider: 'DeepSeek',
    description: 'DeepSeek direct API fast V4 model.',
  });
  assert.equal(flash.displayName, 'Sira Rápido');
  assert.equal(flash.provider, 'DeepSeek');
  assert.equal(/deepseek/i.test(String(flash.displayName)), false);
  assert.equal(/deepseek/i.test(String(flash.description)), false);

  const pro = publicPickerModel({
    name: 'deepseek/deepseek-v4-pro',
    displayName: 'Deepseek V4 PRO',
    provider: 'OpenRouter',
    description: 'Deepseek V4 PRO via OpenRouter.',
  });
  assert.equal(pro.displayName, 'Sira Pro');
  assert.equal(/deepseek/i.test(String(pro.displayName)), false);
  assert.equal(/deepseek/i.test(String(pro.description)), false);
});

test('publicPickerModel: Sira Mini never leaks moondream / Ollama / HuggingFace / gemma4', () => {
  const publicModel = publicPickerModel({
    id: 'row-1',
    name: 'moondream:latest',
    displayName: 'Moondream',
    provider: 'Ollama',
    description: 'HuggingFace moondream via Ollama',
    type: 'TEXT',
    isActive: true,
  });
  assert.equal(publicModel.name, SIRA_MINI_PUBLIC_NAME);
  assert.equal(publicModel.displayName, 'SiraGPT Mini');
  assert.equal(publicModel.description, 'Modelo rápido multimodal de SiraGPT.');
  assert.equal(publicModel.provider, 'Sira');
  const blob = JSON.stringify(publicModel).toLowerCase();
  assert.equal(blob.includes('moondream'), false);
  assert.equal(blob.includes('ollama'), false);
  assert.equal(blob.includes('huggingface'), false);
  const gemmaPublic = publicPickerModel({
    id: 'row-2',
    name: 'gemma4:26b',
    displayName: 'Gemma 4',
    provider: 'Ollama',
    description: 'gemma4:26b via Ollama',
    type: 'TEXT',
    isActive: true,
  });
  assert.equal(gemmaPublic.name, SIRA_MINI_PUBLIC_NAME);
  assert.equal(gemmaPublic.displayName, 'SiraGPT Mini');
  const gemmaBlob = JSON.stringify(gemmaPublic).toLowerCase();
  assert.equal(gemmaBlob.includes('gemma4'), false);
  assert.equal(gemmaBlob.includes('ollama'), false);
});

test('collapseSiraMiniRows keeps one Mini row and prefers sira-mini over gemma4/moondream', () => {
  const collapsed = collapseSiraMiniRows([
    { name: 'gemma4:26b', displayName: 'SiraGPT Mini' },
    { name: 'sira-mini', displayName: 'SiraGPT Mini' },
    { name: 'moondream', displayName: 'SiraGPT Mini' },
    { name: 'deepseek-v4-flash', displayName: 'Sira Rápido' },
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].name, 'sira-mini');
  assert.equal(collapsed[1].name, 'deepseek-v4-flash');
  const onlyMoondream = collapseSiraMiniRows([
    { name: 'moondream:latest', displayName: 'SiraGPT Mini' },
    { name: 'gpt-4o', displayName: 'GPT-4o' },
  ]);
  assert.equal(onlyMoondream[0].name, 'moondream:latest');
});

test('catalogProviderForConnection canonicalises custom → Custom', () => {
  assert.equal(catalogProviderForConnection('custom', 'Ollama local'), 'Custom');
  assert.equal(catalogProviderForConnection('openai', 'OpenAI'), 'OpenAI');
});

test('defaultCustomDisplayName: moondream / gemma4 → Sira Mini without a vendor display_name', () => {
  assert.equal(defaultCustomDisplayName('moondream', ''), 'SiraGPT Mini');
  assert.equal(defaultCustomDisplayName('moondream:latest', 'Moondream'), 'SiraGPT Mini');
  assert.equal(defaultCustomDisplayName('moondream', 'Sira Mini'), 'SiraGPT Mini');
  assert.equal(defaultCustomDisplayName('sira-mini', ''), 'SiraGPT Mini');
  assert.equal(defaultCustomDisplayName('gemma4:26b', 'Gemma 4'), 'SiraGPT Mini');
  assert.equal(defaultCustomDisplayName('llama3.2', 'Llama 3.2'), 'Llama 3.2');
});

test('isLocalVisionModel: moondream / llava are multimodal', () => {
  assert.equal(isLocalVisionModel('moondream'), true);
  assert.equal(isLocalVisionModel('moondream:latest'), true);
  assert.equal(isLocalVisionModel('sira-mini'), true);
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
    { url: 'http://siragpt-ollama:11434/v1/', apiKey: null, authType: 'None' },
    { OpenAI: FakeOpenAI },
  );

  assert.equal(client.opts.baseURL, SIRA_MINI_DEFAULT_BASE_URL);
  assert.notEqual(client.opts.baseURL, 'https://api.openai.com/v1');
  assert.ok(!String(client.opts.baseURL).includes('api.openai.com'));
  assert.equal(client.opts.apiKey, 'local');
  assert.equal(captured.length, 1);
});

test('ollamaNativeChatUrl maps /v1 host to native /api/chat, never /v1/chat/completions', () => {
  assert.equal(ollamaNativeChatUrl(SIRA_MINI_DEFAULT_BASE_URL), 'http://siragpt-ollama:11434/api/chat');
  assert.equal(ollamaNativeChatUrl('http://siragpt-ollama:11434/v1/'), 'http://siragpt-ollama:11434/api/chat');
  assert.equal(SIRA_MINI_NATIVE_CHAT_PATH, '/api/chat');
  assert.equal(/\/v1\/chat\/completions/i.test(ollamaNativeChatUrl(SIRA_MINI_DEFAULT_BASE_URL)), false);
});

test('buildOllamaNativeChatBody: Mini payload is /api/chat + think false + keep_alive -1', () => {
  const body = buildOllamaNativeChatBody({
    model: 'sira-mini',
    messages: [{ role: 'user', content: 'Hola' }],
    stream: true,
  }, {});
  assert.equal(body.model, 'sira-mini');
  assert.equal(body.think, false);
  assert.equal(body.think, SIRA_MINI_THINK);
  assert.equal(body.keep_alive, -1);
  assert.equal(body.keep_alive, SIRA_MINI_KEEP_ALIVE);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Hola' }]);
  assert.equal(rewriteCustomChatModel('moondream'), SIRA_MINI_UPSTREAM_DEFAULT);
  assert.equal(rewriteCustomChatModel('gemma4:26b'), 'sira-mini');
});

test('createCustomProviderClient sends Mini chat to native /api/chat, not OpenAI /v1', async () => {
  const openaiCalls = [];
  const fetchCalls = [];
  class FakeOpenAI {
    constructor(opts) {
      this.opts = opts;
      this.chat = {
        completions: {
          create: async (body) => {
            openaiCalls.push(body);
            return { id: 'cmpl' };
          },
        },
      };
    }
  }
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { message: { role: 'assistant', content: '¡Hola!' }, done: true };
      },
    };
  };
  const previous = process.env.SIRA_MINI_UPSTREAM_ID;
  try {
    delete process.env.SIRA_MINI_UPSTREAM_ID;
    const client = createCustomProviderClient(
      { url: SIRA_MINI_DEFAULT_BASE_URL, apiKey: null, authType: 'None' },
      { OpenAI: FakeOpenAI, fetchImpl },
    );
    const out = await client.chat.completions.create({
      model: 'sira-mini',
      messages: [{ role: 'user', content: 'Hola' }],
    });
    assert.equal(openaiCalls.length, 0, 'Mini must not use OpenAI /v1/chat/completions');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://siragpt-ollama:11434/api/chat');
    assert.equal(/\/v1\/chat\/completions/i.test(fetchCalls[0].url), false);
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.model, 'sira-mini');
    assert.equal(sent.think, false);
    assert.equal(sent.keep_alive, -1);
    assert.equal(sent.stream, false);
    assert.equal(out.choices[0].message.content, '¡Hola!');
    assert.equal(client.opts.baseURL, 'http://siragpt-ollama:11434/v1');
  } finally {
    if (previous === undefined) delete process.env.SIRA_MINI_UPSTREAM_ID;
    else process.env.SIRA_MINI_UPSTREAM_ID = previous;
  }
});

test('createCustomProviderClient streams Mini via native /api/chat NDJSON', async () => {
  const openaiCalls = [];
  class FakeOpenAI {
    constructor(opts) {
      this.opts = opts;
      this.chat = {
        completions: {
          create: async (body) => {
            openaiCalls.push(body);
            return { id: 'cmpl' };
          },
        },
      };
    }
  }
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://siragpt-ollama:11434/api/chat');
    const sent = JSON.parse(init.body);
    assert.equal(sent.think, false);
    assert.equal(sent.keep_alive, -1);
    assert.equal(sent.stream, true);
    assert.equal(/\/v1\/chat\/completions/i.test(url), false);
    return {
      ok: true,
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          yield '{"message":{"role":"assistant","content":"¡Hola"},"done":false}\n';
          yield '{"message":{"role":"assistant","content":"!"},"done":false}\n';
          yield '{"message":{"role":"assistant","content":""},"done":true}\n';
        },
      },
    };
  };
  const client = createCustomProviderClient(
    { url: SIRA_MINI_DEFAULT_BASE_URL, apiKey: null, authType: 'None' },
    { OpenAI: FakeOpenAI, fetchImpl },
  );
  const stream = await client.chat.completions.create({
    model: 'gemma4:26b',
    messages: [{ role: 'user', content: 'Hola' }],
    stream: true,
  });
  const parts = [];
  for await (const chunk of stream) {
    const delta = chunk.choices[0].delta.content;
    if (delta) parts.push(delta);
  }
  assert.equal(openaiCalls.length, 0);
  assert.equal(parts.join(''), '¡Hola!');
});

test('createCustomProviderClient: Mini native failure stays branded, no ollama/model_id leak', async () => {
  class FakeOpenAI {
    constructor(opts) { this.opts = opts; }
  }
  const client = createCustomProviderClient(
    { url: SIRA_MINI_DEFAULT_BASE_URL, apiKey: null, authType: 'None' },
    {
      OpenAI: FakeOpenAI,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    },
  );
  await assert.rejects(
    () => client.chat.completions.create({
      model: 'sira-mini',
      messages: [{ role: 'user', content: 'Hola' }],
    }),
    (err) => {
      const blob = String(err && err.message || '').toLowerCase();
      assert.match(String(err.message), /SiraGPT Mini/);
      assert.equal(blob.includes('gemma4'), false);
      assert.equal(blob.includes('ollama'), false);
      assert.equal(blob.includes('moondream'), false);
      assert.equal(blob.includes('deepseek'), false);
      assert.equal(blob.includes('model_id'), false);
      return true;
    },
  );
});

test('createCustomProviderClient keeps non-Mini Custom on the OpenAI-compatible path', async () => {
  const openaiCalls = [];
  const fetchCalls = [];
  class FakeOpenAI {
    constructor(opts) {
      this.opts = opts;
      this.chat = {
        completions: {
          create: async (body) => {
            openaiCalls.push(body);
            return { id: 'cmpl', choices: [{ message: { content: 'ok' } }] };
          },
        },
      };
    }
  }
  const client = createCustomProviderClient(
    { url: SIRA_MINI_DEFAULT_BASE_URL, apiKey: null, authType: 'None' },
    {
      OpenAI: FakeOpenAI,
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        throw new Error('native fetch must not run for non-Mini');
      },
    },
  );
  await client.chat.completions.create({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'hola' }],
  });
  assert.equal(fetchCalls.length, 0);
  assert.equal(openaiCalls.length, 1);
  assert.equal(openaiCalls[0].model, 'llama3.2');
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
    { id: 'match', providerKey: 'custom', url: 'http://siragpt-ollama:11434/v1', modelIds: ['moondream'] },
  ];
  const picked = pickCustomConnectionRow(rows, 'moondream:latest');
  assert.equal(picked.id, 'match');
  assert.equal(picked.url, 'http://siragpt-ollama:11434/v1');
  const miniAlias = pickCustomConnectionRow(rows, 'sira-mini');
  assert.equal(miniAlias.id, 'match');
});

test('shapeConnection: auth None drops the key even if a leftover blob exists', () => {
  const shaped = shapeConnection({
    id: 'c1',
    url: 'http://siragpt-ollama:11434/v1/',
    authType: 'None',
    apiKey: 'enc:v1:should-not-be-used',
  });
  assert.equal(shaped.url, 'http://siragpt-ollama:11434/v1');
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
          url: 'http://siragpt-ollama:11434/v1',
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
    model: 'sira-mini',
    prisma,
  });
  assert.equal(resolved.isCustom, true);
  assert.ok(resolved.connection);
  assert.equal(resolved.connection.url, SIRA_MINI_DEFAULT_BASE_URL);
  assert.equal(resolved.connection.apiKey, null);
  assert.equal(resolved.catalog.displayName, 'Sira Mini');
});

test('resolveCustomConnectionForTurn: Sira Mini falls back to siragpt-ollama:11434/v1', async () => {
  const prisma = {
    aiModel: {
      findUnique: async () => null,
    },
    adminConnection: {
      findMany: async () => [],
    },
  };
  const resolved = await resolveCustomConnectionForTurn({
    provider: 'Sira',
    model: 'sira-mini',
    prisma,
  });
  assert.equal(resolved.isCustom, true);
  assert.equal(resolved.connection.url, 'http://siragpt-ollama:11434/v1');
  assert.equal(resolved.connection.authType, 'None');
  assert.equal(resolved.connection.apiKey, null);
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
          url: 'http://siragpt-ollama:11434/v1',
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
  assert.match(src, /client: openai/, 'plain stream must reuse the Custom client, not getClient(Custom)→OpenAI');
  assert.match(src, /!isSiraMiniAlias\(actualModel\)/, 'Mini must skip the agentic loop so a tool-call miss cannot fall through to DeepSeek');
  assert.doesNotMatch(src, /OPENAI_BASE_URL/, 'must not stuff Custom into OPENAI_BASE_URL');
});

test('getFallbackChain: Custom / SiraGPT Mini never includes DeepSeek Flash', () => {
  const service = require('../src/services/ai-service');
  const keys = ['FALLBACK_MODELS', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  delete process.env.FALLBACK_MODELS;
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
  process.env.OPENAI_API_KEY = 'sk-openai';
  try {
    assert.deepEqual(service.__test.getFallbackChain('Custom', 'sira-mini'), []);
    assert.deepEqual(service.__test.getFallbackChain('Sira', 'SiraGPT Mini'), []);
    assert.deepEqual(service.__test.getFallbackChain('DeepSeek', 'sira-mini'), []);
    assert.equal(service.__test.isPinnedLocalGenerate('Custom', 'sira-mini'), true);
    assert.equal(service.__test.providerForModel('sira-mini'), 'Custom');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('generateStream: Mini failure errors in Spanish and never swaps to DeepSeek', async () => {
  const service = require('../src/services/ai-service');
  const { SIRA_MINI_UNAVAILABLE_MESSAGE } = require('../src/services/ai/custom-provider-client');
  const seen = [];
  const frames = [];
  const originalGetClient = service.getClient;
  service.getClient = (provider) => {
    seen.push(provider);
    const err = new Error('upstream down');
    err.status = 503;
    throw err;
  };
  const failingClient = {
    chat: {
      completions: {
        create: async () => {
          const err = new Error('ollama down');
          err.status = 503;
          throw err;
        },
      },
    },
  };
  try {
    const out = await service.generateStream({
      provider: 'Custom',
      model: 'sira-mini',
      client: failingClient,
      messages: [{ role: 'user', content: 'hola' }],
      res: { write: (chunk) => { frames.push(String(chunk)); return true; } },
      qualityGuard: false,
      skipDoneSentinel: true,
    });
    assert.equal(out, SIRA_MINI_UNAVAILABLE_MESSAGE);
    assert.equal(seen.includes('DeepSeek'), false);
    assert.equal(seen.includes('OpenAI'), false);
    const blob = frames.join('\n');
    assert.match(blob, /sira_mini_unavailable/);
    assert.match(blob, /SiraGPT Mini no está disponible/);
    assert.equal(/deepseek-v4-flash|Sira Rápido/i.test(blob), false);
  } finally {
    service.getClient = originalGetClient;
  }
});
