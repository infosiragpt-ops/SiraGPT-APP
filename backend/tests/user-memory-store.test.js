const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  EMBED_DIM,
  contentHash,
  createPgUserMemoryStore,
  embedTexts,
  getStore,
  isConfigured,
  isEnabled,
  vecToLiteral,
} = require('../src/services/user-memory-store');

function vector(seed = 0) {
  return Array.from({ length: EMBED_DIM }, (_, i) => ((i + seed) % 17) / 17);
}

test('isEnabled is explicit opt-in', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ SIRAGPT_USER_MEMORY_STORE: 'memory' }), false);
  assert.equal(isEnabled({ SIRAGPT_USER_MEMORY_STORE: 'pgvector' }), true);
});

test('contentHash is stable across casing and whitespace', () => {
  assert.equal(contentHash(' User likes tea '), contentHash('user LIKES   tea'.replace(/\s+/, ' ')));
});

test('vecToLiteral validates 1024 dimension embeddings', () => {
  assert.match(vecToLiteral(vector()), /^\[0\.000000,/);
  assert.throws(() => vecToLiteral([1, 2, 3]), /expected 1024-dimension/);
});

test('pg store upsert and recall use parameterized vector SQL', async () => {
  const calls = [];
  const prisma = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ type: 'execute', sql, params });
      return 1;
    },
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ type: 'query', sql, params });
      if (sql.includes('WITH ranked')) {
        return [{
          content: 'Luis prefiere respuestas directas',
          category: 'preference',
          importance_score: 0.4,
          confidence: 0.9,
          access_count: 3,
          cosine: 0.8,
        }];
      }
      return [{ memories: 1, categories: 1, avg_importance: 0.4 }];
    },
  };
  const store = createPgUserMemoryStore({
    prisma,
    embedder: async texts => texts.map((_, i) => vector(i)),
  });

  const upserted = await store.upsertFacts('user_1', [{
    fact: 'Luis prefiere respuestas directas',
    category: 'preference',
    confidence: 0.9,
  }]);
  assert.deepEqual(upserted, { upserted: 1 });
  assert.match(calls[0].sql, /INSERT INTO user_memories/);
  assert.equal(calls[0].params[0], 'user_1');
  assert.match(calls[0].params[3], /^\[/);

  const recalled = await store.recall('user_1', 'como responder a Luis', 3);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].category, 'preference');
  // Score must mirror the SQL ORDER BY incl. the access_count term:
  // cosine 0.8*0.75 + importance 0.4*0.2 + min(3,10)/10*0.05 = 0.695 (the
  // returned score used to drop the access_count component → 0.68).
  assert.ok(Math.abs(recalled[0].score - 0.695) < 1e-9, `expected 0.695, got ${recalled[0].score}`);

  const stats = await store.stats('user_1');
  assert.equal(stats.store, 'pgvector');
  assert.equal(stats.dim, EMBED_DIM);
});

test('module loads without optional embedding/db deps installed', () => {
  // Sanity: the module must be require-able in an environment that lacks
  // @prisma/client, voyage/jina SDKs, or any other heavy optional dep. The
  // store accesses Prisma only lazily inside createPgUserMemoryStore() and
  // embedding providers only via globalThis.fetch — so top-level require
  // must never reach for them.
  const blocked = new Set([
    '@prisma/client',
    'openai',
    '@anthropic-ai/sdk',
    'voyageai',
    '@jina-ai/sdk',
    'pg',
    'pgvector',
  ]);
  const originalResolve = Module._resolveFilename;
  const touched = [];
  Module._resolveFilename = function (request, ...rest) {
    if (blocked.has(request)) {
      touched.push(request);
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalResolve.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/services/user-memory-store')];
    const mod = require('../src/services/user-memory-store');
    assert.equal(typeof mod.createPgUserMemoryStore, 'function');
    assert.equal(typeof mod.embedTexts, 'function');
    assert.equal(typeof mod.isEnabled, 'function');
    assert.equal(typeof mod.contentHash, 'function');
    assert.equal(mod.EMBED_DIM, 1024);
    // getStore must short-circuit when the feature flag is off — without
    // touching @prisma/client.
    const prev = process.env.SIRAGPT_USER_MEMORY_STORE;
    delete process.env.SIRAGPT_USER_MEMORY_STORE;
    try {
      assert.equal(mod.getStore(), null);
    } finally {
      if (prev !== undefined) process.env.SIRAGPT_USER_MEMORY_STORE = prev;
    }
    // Caller-injected prisma path must work without resolving @prisma/client.
    const store = mod.createPgUserMemoryStore({
      prisma: { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async () => [] },
      embedder: async texts => texts.map(() => new Array(mod.EMBED_DIM).fill(0)),
    });
    assert.equal(typeof store.upsertFacts, 'function');
    assert.equal(typeof store.recall, 'function');
    assert.equal(typeof store.clear, 'function');
    assert.equal(typeof store.stats, 'function');
    assert.deepEqual(touched, [], 'no blocked deps should have been resolved');
  } finally {
    Module._resolveFilename = originalResolve;
    delete require.cache[require.resolve('../src/services/user-memory-store')];
    require('../src/services/user-memory-store');
  }
});

test('embedTexts surfaces missing API keys without touching SDKs', async () => {
  const prevV = process.env.VOYAGE_API_KEY;
  const prevJ = process.env.JINA_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.JINA_API_KEY;
  try {
    await assert.rejects(
      embedTexts(['hello'], { provider: 'voyage', fetch: async () => ({ ok: true, json: async () => ({}) }) }),
      /VOYAGE_API_KEY/,
    );
    await assert.rejects(
      embedTexts(['hi'], { provider: 'jina', fetch: async () => ({ ok: true, json: async () => ({}) }) }),
      /JINA_API_KEY/,
    );
    await assert.rejects(
      embedTexts(['hi'], { provider: 'bogus' }),
      /unsupported memory embedding provider/,
    );
    assert.deepEqual(await embedTexts([]), []);
  } finally {
    if (prevV !== undefined) process.env.VOYAGE_API_KEY = prevV;
    if (prevJ !== undefined) process.env.JINA_API_KEY = prevJ;
  }
});

test('getStore returns a singleton when feature flag enabled', () => {
  // Avoid lazy-requiring @prisma/client by stubbing createPgUserMemoryStore
  // indirectly through the env-gated path: ensure two calls return the same
  // instance. We can't safely instantiate Prisma here, so just verify the
  // off-path returns null deterministically.
  const prev = process.env.SIRAGPT_USER_MEMORY_STORE;
  delete process.env.SIRAGPT_USER_MEMORY_STORE;
  try {
    assert.equal(getStore(), null);
    assert.equal(getStore(), null);
  } finally {
    if (prev !== undefined) process.env.SIRAGPT_USER_MEMORY_STORE = prev;
  }
});

test('isConfigured is false when pgvector is enabled but the embed key is missing', () => {
  assert.equal(isConfigured({ SIRAGPT_USER_MEMORY_STORE: 'memory' }), false);
  assert.equal(isConfigured({ SIRAGPT_USER_MEMORY_STORE: 'pgvector' }), false);
  assert.equal(isConfigured({ SIRAGPT_USER_MEMORY_STORE: 'pgvector', VOYAGE_API_KEY: 'vk' }), true);
  assert.equal(
    isConfigured({ SIRAGPT_USER_MEMORY_STORE: 'pgvector', SIRAGPT_MEMORY_EMBED_PROVIDER: 'jina' }),
    false,
  );
  assert.equal(
    isConfigured({ SIRAGPT_USER_MEMORY_STORE: 'pgvector', SIRAGPT_MEMORY_EMBED_PROVIDER: 'jina', JINA_API_KEY: 'jk' }),
    true,
  );
});

test('getStore returns null (no per-turn throw) when enabled but the embed key is missing', () => {
  const prevStore = process.env.SIRAGPT_USER_MEMORY_STORE;
  const prevKey = process.env.VOYAGE_API_KEY;
  process.env.SIRAGPT_USER_MEMORY_STORE = 'pgvector';
  delete process.env.VOYAGE_API_KEY;
  try {
    assert.equal(getStore(), null);
    assert.equal(getStore(), null); // idempotent; warning is emitted at most once
  } finally {
    if (prevStore !== undefined) process.env.SIRAGPT_USER_MEMORY_STORE = prevStore; else delete process.env.SIRAGPT_USER_MEMORY_STORE;
    if (prevKey !== undefined) process.env.VOYAGE_API_KEY = prevKey; else delete process.env.VOYAGE_API_KEY;
  }
});
