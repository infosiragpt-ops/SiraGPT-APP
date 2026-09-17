const test = require('node:test');
const assert = require('node:assert/strict');

// Music providers (elevenlabs / minimax / suno) through Admin → Conexiones:
// panel keys must reach the music services via the env bridge, and the
// per-connection "Probar" verdict must not false-red (MiniMax / Suno
// gateways expose no /models endpoint; their models ship in the manifest).

const databasePath = require.resolve('../src/config/database');
const bridgePath = require.resolve('../src/services/admin-connections-bridge');

function installDatabaseMock(rows) {
  const previous = require.cache[databasePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {
      adminConnection: {
        findMany: async (args = {}) => (args.where ? rows : rows.map((r, i) => ({ id: `conn_${i}`, providerKey: r.providerKey }))),
        update: async (p) => p,
      },
    },
  };
  return previous;
}

function withFreshBridge(fn) {
  const previousBridge = require.cache[bridgePath];
  delete require.cache[bridgePath];
  return (async () => {
    try {
      return await fn(require('../src/services/admin-connections-bridge'));
    } finally {
      delete require.cache[bridgePath];
      if (previousBridge) require.cache[bridgePath] = previousBridge;
    }
  })();
}

const ENV_NAMES = ['ELEVENLABS_API_KEY', 'MINIMAX_API_KEY', 'SUNO_API_KEY', 'OPENROUTER_API_KEY', 'ENCRYPTION_KEY'];

function snapshotEnv() {
  return Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
}

function restoreEnv(saved) {
  for (const [n, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
}

test('elevenlabs panel key applies to ELEVENLABS_API_KEY and probes with xi-api-key', async () => {
  const savedEnv = snapshotEnv();
  const previousDb = installDatabaseMock([
    { providerKey: 'elevenlabs', apiKey: 'eleven-panel-key', updatedAt: new Date() },
  ]);
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), headers: options.headers || {} });
    return { ok: true, status: 200 };
  };
  for (const n of ENV_NAMES) delete process.env[n];
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  try {
    await withFreshBridge(async (bridge) => {
      assert.ok(bridge.PROVIDER_ENV_MAP.elevenlabs === 'ELEVENLABS_API_KEY');
      assert.ok(bridge.PROVIDER_ENV_MAP.minimax === 'MINIMAX_API_KEY');
      assert.ok(bridge.PROVIDER_ENV_MAP.suno === 'SUNO_API_KEY');
      await bridge.applyAdminConnections();
      assert.equal(process.env.ELEVENLABS_API_KEY, 'eleven-panel-key');
      const probe = fetchCalls.find((c) => c.url === 'https://api.elevenlabs.io/v1/models');
      assert.ok(probe, 'must probe the ElevenLabs key');
      assert.equal(probe.headers['xi-api-key'], 'eleven-panel-key');
    });
  } finally {
    global.fetch = originalFetch;
    restoreEnv(savedEnv);
    if (previousDb) require.cache[databasePath] = previousDb;
    else delete require.cache[databasePath];
  }
});

test('minimax/suno panel keys apply without probing and reconcile as unprobed-healthy', async () => {
  const savedEnv = snapshotEnv();
  const previousDb = installDatabaseMock([
    { providerKey: 'minimax', apiKey: 'minimax-panel-key', updatedAt: new Date() },
    { providerKey: 'suno', apiKey: 'suno-panel-key', updatedAt: new Date() },
  ]);
  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options = {}) => {
    fetchCalls.push(String(url));
    return { ok: true, status: 200 };
  };
  for (const n of ENV_NAMES) delete process.env[n];
  process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  try {
    await withFreshBridge(async (bridge) => {
      await bridge.applyAdminConnections();
      assert.equal(process.env.MINIMAX_API_KEY, 'minimax-panel-key');
      assert.equal(process.env.SUNO_API_KEY, 'suno-panel-key');
      assert.equal(fetchCalls.some((u) => u.includes('minimax')), false, 'minimax must not be probed');
      assert.equal(fetchCalls.some((u) => u.includes('suno')), false, 'suno must not be probed');
      const results = await bridge.reconcileCatalog();
      assert.deepEqual(results.minimax, { healthy: true, reason: 'unprobed' });
      assert.deepEqual(results.suno, { healthy: true, reason: 'unprobed' });
    });
  } finally {
    global.fetch = originalFetch;
    restoreEnv(savedEnv);
    if (previousDb) require.cache[databasePath] = previousDb;
    else delete require.cache[databasePath];
  }
});

test('music connections keep their providerKey (no custom demotion)', async () => {
  const fs = require('fs');
  const path = require('path');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/admin-connections.js'), 'utf8');
  for (const key of ['elevenlabs', 'minimax', 'suno']) {
    assert.match(routeSource, new RegExp(`'${key}'`, 'g'), `${key} must be a known provider`);
  }
  const uiSource = fs.readFileSync(path.join(__dirname, '../../app/admin/connections/page.tsx'), 'utf8');
  for (const key of ['elevenlabs', 'minimax', 'suno']) {
    assert.ok(uiSource.includes(`key: "${key}"`), `admin UI must list ${key}`);
  }
});
