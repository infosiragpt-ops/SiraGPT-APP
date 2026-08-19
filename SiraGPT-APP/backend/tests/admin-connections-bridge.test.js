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

// ─── Auth-gated apply: a bad panel key can never shadow a working one ───────

function withBridgeHarness({ rows, fetchImpl }, fn) {
  const databasePath = require.resolve('../src/config/database');
  const bridgePath = require.resolve('../src/services/admin-connections-bridge');
  const previousDatabase = require.cache[databasePath];
  const previousBridge = require.cache[bridgePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      adminConnection: {
        findMany: async (args = {}) => (args.where ? rows : []),
        update: async (p) => p,
      },
    },
  };
  delete require.cache[bridgePath];
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalEnc = process.env.ENCRYPTION_KEY;
  global.fetch = fetchImpl;
  process.env.OPENAI_API_KEY = 'sk-from-dotenv';
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  return (async () => {
    try {
      const { applyAdminConnections } = require('../src/services/admin-connections-bridge');
      await applyAdminConnections();
      await fn();
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
      if (originalEnc === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = originalEnc;
      delete require.cache[bridgePath];
      if (previousBridge) require.cache[bridgePath] = previousBridge;
      if (previousDatabase) require.cache[databasePath] = previousDatabase;
      else delete require.cache[databasePath];
    }
  })();
}

test('a 401-rejected recent key falls through to the older working connection', async () => {
  await withBridgeHarness({
    rows: [
      { providerKey: 'openai', apiKey: 'fish_broken', updatedAt: new Date('2026-07-04') },
      { providerKey: 'openai', apiKey: 'sk-old-good', updatedAt: new Date('2026-07-01') },
    ],
    fetchImpl: async (url, options = {}) => {
      const auth = options.headers?.Authorization || '';
      if (auth.includes('fish_broken')) return { ok: false, status: 401 };
      return { ok: true, status: 200 };
    },
  }, async () => {
    assert.equal(process.env.OPENAI_API_KEY, 'sk-old-good');
  });
});

test('all candidates rejected → .env key restored (never a broken override)', async () => {
  await withBridgeHarness({
    rows: [{ providerKey: 'openai', apiKey: 'fish_broken', updatedAt: new Date() }],
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }, async () => {
    assert.equal(process.env.OPENAI_API_KEY, 'sk-from-dotenv');
  });
});

test('network errors are inconclusive — the recent key still applies (fail-open)', async () => {
  await withBridgeHarness({
    rows: [{ providerKey: 'openai', apiKey: 'sk-panel-key', updatedAt: new Date() }],
    fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
  }, async () => {
    assert.equal(process.env.OPENAI_API_KEY, 'sk-panel-key');
  });
});

test('SIRAGPT_CONN_BRIDGE_PROBE=0 disables the gate entirely', async () => {
  process.env.SIRAGPT_CONN_BRIDGE_PROBE = '0';
  try {
    await withBridgeHarness({
      rows: [{ providerKey: 'openai', apiKey: 'fish_broken', updatedAt: new Date() }],
      fetchImpl: async () => ({ ok: false, status: 401 }),
    }, async () => {
      assert.equal(process.env.OPENAI_API_KEY, 'fish_broken');
    });
  } finally {
    delete process.env.SIRAGPT_CONN_BRIDGE_PROBE;
  }
});
