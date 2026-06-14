'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelSyncService } = require('../src/services/model-sync-service');

// A minimal fetch Response stub.
function fakeResponse({ ok = true, status = 200, json = null, text = '' } = {}) {
  return {
    ok,
    status,
    async json() {
      if (json === null) throw new Error('no json');
      return json;
    },
    async text() {
      return text;
    },
  };
}

// Records the (url, init) of every call so header/URL assertions are possible.
function recordingFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === 'function') return response(url, init);
    return response;
  };
  impl.calls = calls;
  return impl;
}

test('_normalizeRawModelList maps OpenAI/Anthropic/bare shapes and skips empties', () => {
  const svc = new ModelSyncService();
  const out = svc._normalizeRawModelList(
    [
      { id: 'gpt-4o' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { name: 'models/gemini-2.5-pro' },
      { id: '' }, // skipped
      null, // skipped
    ],
    'OpenAI',
    'connection'
  );

  assert.equal(out.length, 3);
  const byName = Object.fromEntries(out.map((m) => [m.name, m]));
  assert.ok(byName['gpt-4o']);
  assert.equal(byName['gpt-4o'].provider, 'OpenAI');
  assert.equal(byName['gpt-4o'].isActive, false);
  assert.equal(byName['gpt-4o'].syncSource, 'connection');
  // display_name preferred over formatted name
  assert.equal(byName['claude-sonnet-4-6'].displayName, 'Claude Sonnet 4.6');
  // `models/` prefix stripped from Gemini-style ids
  assert.ok(byName['gemini-2.5-pro']);
});

test('fetchModelsFromEndpoint returns normalized inactive models on OpenAI-shape payload', async () => {
  const svc = new ModelSyncService();
  const fetchImpl = recordingFetch(
    fakeResponse({ json: { data: [{ id: 'zzz-fake-chat-1' }, { id: 'zzz-fake-chat-2' }] } })
  );

  const res = await svc.fetchModelsFromEndpoint({
    url: 'https://example.test/v1/models',
    apiKey: 'sk-test',
    providerLabel: 'OpenAI',
    providerKey: 'openai',
    fetchImpl,
  });

  assert.equal(res.ok, true);
  assert.equal(res.models.length, 2);
  assert.ok(res.models.every((m) => m.isActive === false));
  // Bearer auth header sent
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(fetchImpl.calls[0].url, 'https://example.test/v1/models');
});

test('fetchModelsFromEndpoint uses x-api-key + anthropic-version for anthropic', async () => {
  const svc = new ModelSyncService();
  const fetchImpl = recordingFetch(
    fakeResponse({ json: { data: [{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }] } })
  );

  const res = await svc.fetchModelsFromEndpoint({
    url: 'https://api.anthropic.com/v1/models',
    apiKey: 'sk-ant-xyz',
    providerLabel: 'Anthropic',
    providerKey: 'anthropic',
    fetchImpl,
  });

  assert.equal(res.ok, true);
  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers['x-api-key'], 'sk-ant-xyz');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.Authorization, undefined); // no Bearer for anthropic
});

test('fetchModelsFromEndpoint reports HTTP and network failures without throwing', async () => {
  const svc = new ModelSyncService();

  const httpFail = await svc.fetchModelsFromEndpoint({
    url: 'https://example.test/v1/models',
    apiKey: 'k',
    providerKey: 'openai',
    fetchImpl: recordingFetch(fakeResponse({ ok: false, status: 401, text: 'unauthorized' })),
  });
  assert.equal(httpFail.ok, false);
  assert.equal(httpFail.status, 401);
  assert.equal(httpFail.models.length, 0);

  const netFail = await svc.fetchModelsFromEndpoint({
    url: 'https://example.test/v1/models',
    apiKey: 'k',
    providerKey: 'openai',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(netFail.ok, false);
  assert.equal(netFail.models.length, 0);

  const missingUrl = await svc.fetchModelsFromEndpoint({ apiKey: 'k', fetchImpl: recordingFetch(fakeResponse({})) });
  assert.equal(missingUrl.ok, false);
  assert.equal(missingUrl.error, 'missing_url');
});

test('fetchModelsFromEndpoint honours modelIdsFilter (allow-list)', async () => {
  const svc = new ModelSyncService();
  const fetchImpl = recordingFetch(
    fakeResponse({ json: { data: [{ id: 'zzz-keep-me' }, { id: 'zzz-drop-me' }] } })
  );

  const res = await svc.fetchModelsFromEndpoint({
    url: 'https://example.test/v1/models',
    apiKey: 'k',
    providerLabel: 'OpenAI',
    providerKey: 'openai',
    modelIdsFilter: ['zzz-keep-me'],
    fetchImpl,
  });

  assert.equal(res.ok, true);
  assert.equal(res.models.length, 1);
  assert.equal(res.models[0].name, 'zzz-keep-me');
});

test('persistModels creates new rows and only refreshes metadata on existing rows', async () => {
  const created = [];
  const updated = [];
  const existingNames = new Set(['zzz-existing']);
  const mockPrisma = {
    aiModel: {
      findUnique: async ({ where }) => (existingNames.has(where.name) ? { name: where.name, isActive: true } : null),
      create: async ({ data }) => { created.push(data); return data; },
      update: async ({ where, data }) => { updated.push({ where, data }); return data; },
    },
  };
  const svc = new ModelSyncService({ prismaClient: mockPrisma });

  const result = await svc.persistModels([
    { name: 'zzz-new', displayName: 'New', provider: 'OpenAI', type: 'TEXT', isActive: false, syncSource: 'connection' },
    { name: 'zzz-existing', displayName: 'Existing', provider: 'OpenAI', type: 'TEXT', isActive: false, syncSource: 'connection' },
    { name: '' }, // skipped
  ]);

  assert.deepEqual(result, { created: 1, updated: 1, errors: 0 });
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'zzz-new');
  assert.equal(created[0].isActive, false);
  // Existing-row update must NOT carry isActive (admin activation survives).
  assert.equal(Object.prototype.hasOwnProperty.call(updated[0].data, 'isActive'), false);
});

test('syncConnectionModels builds <base>/models, discovers and persists (inactive)', async () => {
  const created = [];
  const mockPrisma = {
    aiModel: {
      findUnique: async () => null,
      create: async ({ data }) => { created.push(data); return data; },
      update: async ({ data }) => data,
    },
  };
  const svc = new ModelSyncService({ prismaClient: mockPrisma });
  const fetchImpl = recordingFetch(
    fakeResponse({ json: { data: [{ id: 'zzz-conn-model' }] } })
  );

  const result = await svc.syncConnectionModels({
    providerKey: 'openai',
    url: 'https://api.openai.com/v1/', // trailing slash → normalized
    authType: 'Bearer',
    apiKey: 'sk-conn',
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(result.count, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(created[0].isActive, false);
  assert.equal(created[0].provider, 'OpenAI'); // mapped from providerKey
});

test('syncConnectionModels returns a failure verdict (no persist) on upstream error', async () => {
  let createdCalled = false;
  const mockPrisma = {
    aiModel: {
      findUnique: async () => null,
      create: async () => { createdCalled = true; return {}; },
      update: async () => ({}),
    },
  };
  const svc = new ModelSyncService({ prismaClient: mockPrisma });

  const result = await svc.syncConnectionModels({
    providerKey: 'openai',
    url: 'https://api.openai.com/v1',
    apiKey: 'bad',
    fetchImpl: recordingFetch(fakeResponse({ ok: false, status: 403, text: 'forbidden' })),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.created, 0);
  assert.equal(createdCalled, false);
});

test('syncConnectionModels rejects a connection with no URL', async () => {
  const svc = new ModelSyncService();
  const result = await svc.syncConnectionModels({ providerKey: 'openai', url: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_url');
});

test('_fetchGenericEnvProviderModels only queries providers whose env key is set', async () => {
  const svc = new ModelSyncService();
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedGroq = process.env.GROQ_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.FIREWORKS_API_KEY;

    const fetchImpl = recordingFetch((url) => {
      if (String(url).includes('anthropic')) {
        return fakeResponse({ json: { data: [{ id: 'claude-haiku-4-5' }] } });
      }
      return fakeResponse({ ok: false, status: 404, text: 'nope' });
    });

    const models = await svc._fetchGenericEnvProviderModels(fetchImpl);
    // Only the anthropic endpoint was hit (others had no key)
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(String(fetchImpl.calls[0].url).includes('anthropic'));
    assert.equal(models.length, 1);
    assert.equal(models[0].provider, 'Anthropic');
    assert.equal(models[0].isActive, false);
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq;
  }
});
