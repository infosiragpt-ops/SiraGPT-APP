const test = require('node:test');
const assert = require('node:assert/strict');

// validateMusicProviderKey (model-sync-service): verdicts for the
// per-connection "Probar" button and auto-discovery on music providers.
// No DB touched: the music branch returns before any persistence.

// model-sync-service (via fal-auth) requires ENCRYPTION_KEY at load.
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}

const databasePath = require.resolve('../src/config/database');

function loadService() {
  const previousDb = require.cache[databasePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { adminConnection: { findMany: async () => [], update: async (p) => p } },
  };
  const servicePath = require.resolve('../src/services/model-sync-service');
  const previousService = require.cache[servicePath];
  delete require.cache[servicePath];
  const service = require('../src/services/model-sync-service');
  return { service, previousDb, previousService, servicePath };
}

function unload({ previousDb, previousService, servicePath }) {
  delete require.cache[servicePath];
  if (previousService) require.cache[servicePath] = previousService;
  if (previousDb) require.cache[databasePath] = previousDb;
  else delete require.cache[databasePath];
}

test('elevenlabs: valid key validates against {base}/models with xi-api-key', async () => {
  const ctx = loadService();
  try {
    const calls = [];
    const result = await ctx.service.syncConnectionModels({
      providerKey: 'elevenlabs',
      url: 'https://api.elevenlabs.io/v1',
      apiKey: 'eleven-key-123',
      fetchImpl: async (url, opts) => {
        calls.push({ url: String(url), headers: opts.headers });
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
    assert.deepEqual(result.models, []);
    assert.equal(result.note, 'key_validated_no_catalog_import');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/models');
    assert.equal(calls[0].headers['xi-api-key'], 'eleven-key-123');
  } finally {
    unload(ctx);
  }
});

test('elevenlabs: rejected key surfaces ok:false without importing', async () => {
  const ctx = loadService();
  try {
    const result = await ctx.service.syncConnectionModels({
      providerKey: 'elevenlabs',
      url: 'https://api.elevenlabs.io/v1',
      apiKey: 'bad-key',
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error, /ElevenLabs API key rejected/);
    assert.equal(result.created, 0);
  } finally {
    unload(ctx);
  }
});

test('minimax/suno: present key accepted without probe and without fetch', async () => {
  const ctx = loadService();
  try {
    let fetched = false;
    for (const providerKey of ['minimax', 'suno']) {
      const result = await ctx.service.syncConnectionModels({
        providerKey,
        url: providerKey === 'minimax' ? 'https://api.minimax.io' : 'https://api.sunoapi.org',
        apiKey: 'some-key',
        fetchImpl: async () => { fetched = true; return { ok: true }; },
      });
      assert.equal(result.ok, true, providerKey);
      assert.equal(result.note, 'key_accepted_without_probe', providerKey);
      assert.deepEqual(result.models, [], providerKey);
    }
    assert.equal(fetched, false, 'no upstream call for unprobed providers');
  } finally {
    unload(ctx);
  }
});

test('music providers: missing key reports missing_api_key', async () => {
  const ctx = loadService();
  try {
    for (const providerKey of ['elevenlabs', 'minimax', 'suno']) {
      const result = await ctx.service.syncConnectionModels({ providerKey, url: 'https://x.test', apiKey: '' });
      assert.equal(result.ok, false, providerKey);
      assert.equal(result.error, 'missing_api_key', providerKey);
    }
  } finally {
    unload(ctx);
  }
});
