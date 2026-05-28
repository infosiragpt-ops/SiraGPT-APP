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
