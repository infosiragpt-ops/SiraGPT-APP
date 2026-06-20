const test = require('node:test');
const assert = require('node:assert/strict');

test('connection health reconciliation never activates admin models', async () => {
  const databasePath = require.resolve('../src/config/database');
  const bridgePath = require.resolve('../src/services/admin-connections-bridge');
  const previousDatabase = require.cache[databasePath];
  const previousBridge = require.cache[bridgePath];
  const aiModelUpdates = [];
  const adminConnectionUpdates = [];

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      aiModel: {
        updateMany: async (payload) => {
          aiModelUpdates.push(payload);
          return { count: 10 };
        },
      },
      adminConnection: {
        findMany: async () => [{ id: 'conn_openrouter', providerKey: 'openrouter' }],
        update: async (payload) => {
          adminConnectionUpdates.push(payload);
          return payload;
        },
      },
    },
  };
  delete require.cache[bridgePath];

  const originalFetch = global.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  global.fetch = async () => ({ ok: true });
  process.env.OPENROUTER_API_KEY = 'sk-test';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  try {
    const { reconcileCatalog } = require('../src/services/admin-connections-bridge');
    const results = await reconcileCatalog();

    assert.equal(results.openrouter.healthy, true);
    assert.equal(aiModelUpdates.length, 0);
    assert.equal(adminConnectionUpdates.length, 1);
    assert.deepEqual(adminConnectionUpdates[0].where, { id: 'conn_openrouter' });
    assert.equal(adminConnectionUpdates[0].data.lastSyncOk, true);
  } finally {
    global.fetch = originalFetch;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
    delete require.cache[bridgePath];
    if (previousBridge) require.cache[bridgePath] = previousBridge;
    if (previousDatabase) require.cache[databasePath] = previousDatabase;
    else delete require.cache[databasePath];
  }
});

test('admin fal.ai connection applies FAL_KEY aliases and probes with Key auth', async () => {
  const databasePath = require.resolve('../src/config/database');
  const bridgePath = require.resolve('../src/services/admin-connections-bridge');
  const previousDatabase = require.cache[databasePath];
  const previousBridge = require.cache[bridgePath];
  const adminConnectionUpdates = [];
  const fetchCalls = [];
  const envNames = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
    'TOGETHER_API_KEY',
    'FIREWORKS_API_KEY',
    'FAL_KEY',
    'FAL_API_KEY',
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      adminConnection: {
        findMany: async (args = {}) => {
          if (args.where) return [{ providerKey: 'fal', apiKey: 'fal-panel-key', updatedAt: new Date() }];
          return [{ id: 'conn_fal', providerKey: 'fal' }];
        },
        update: async (payload) => {
          adminConnectionUpdates.push(payload);
          return payload;
        },
      },
    },
  };
  delete require.cache[bridgePath];

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), authorization: options.headers?.Authorization });
    return { ok: true };
  };
  for (const name of envNames) delete process.env[name];
  process.env.FAL_KEY = 'old-fal-key';
  process.env.FAL_API_KEY = 'old-fal-api-key';

  try {
    const { applyAdminConnections } = require('../src/services/admin-connections-bridge');
    await applyAdminConnections();

    assert.equal(process.env.FAL_KEY, 'fal-panel-key');
    assert.equal(process.env.FAL_API_KEY, 'fal-panel-key');
    assert.ok(fetchCalls.some((call) => call.url === 'https://api.fal.ai/v1/models?limit=1' && call.authorization === 'Key fal-panel-key'));
    assert.equal(adminConnectionUpdates.length, 1);
    assert.equal(adminConnectionUpdates[0].data.lastSyncOk, true);
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[bridgePath];
    if (previousBridge) require.cache[bridgePath] = previousBridge;
    if (previousDatabase) require.cache[databasePath] = previousDatabase;
    else delete require.cache[databasePath];
  }
});
