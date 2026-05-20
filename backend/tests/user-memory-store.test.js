const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  EMBED_DIM,
  contentHash,
  createPgUserMemoryStore,
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
  assert.ok(recalled[0].score > 0);

  const stats = await store.stats('user_1');
  assert.equal(stats.store, 'pgvector');
  assert.equal(stats.dim, EMBED_DIM);
});
