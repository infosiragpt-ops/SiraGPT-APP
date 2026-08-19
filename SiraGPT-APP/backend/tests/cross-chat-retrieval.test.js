'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  indexTurn,
  recallSimilarTurns,
  buildCrossChatBlock,
  sanitizeTurn,
  daysSince,
  relativeAge,
  contentHash,
  vecToLiteral,
  CATEGORY_USER,
  CATEGORY_ASSISTANT,
} = require('../src/services/cross-chat-retrieval');

function fakeEmbedder(vector = [0.1, 0.2, 0.3, 0.4]) {
  const calls = [];
  const fn = async (texts) => {
    calls.push(texts);
    return texts.map(() => vector);
  };
  fn.__calls = calls;
  return fn;
}

function fakePrisma({ insertedRows = [], queryRows = [], replyMap = {} } = {}) {
  const insertions = [];
  const queries = [];
  return {
    insertions,
    queries,
    $executeRawUnsafe: async (sql, ...args) => {
      insertions.push({ sql, args });
      insertedRows.push(args);
      return 1;
    },
    $queryRawUnsafe: async (sql, ...args) => {
      queries.push({ sql, args });
      if (sql.includes('FROM user_memories')) return queryRows;
      if (sql.includes('FROM messages')) {
        const chatId = args[0];
        const reply = replyMap[chatId];
        return reply ? [{ content: reply, createdAt: new Date().toISOString() }] : [];
      }
      return [];
    },
  };
}

test.beforeEach(() => {
  delete process.env.ENABLE_CROSS_CHAT_RECALL;
});

test.afterEach(() => {
  delete process.env.ENABLE_CROSS_CHAT_RECALL;
});

test('isEnabled: defaults to false', () => {
  assert.strictEqual(isEnabled(), false);
});

test('isEnabled: true when env is "1", "true", "yes", "on"', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'YES']) {
    process.env.ENABLE_CROSS_CHAT_RECALL = v;
    assert.strictEqual(isEnabled(), true, `expected true for ${v}`);
  }
});

test('sanitizeTurn: collapses whitespace and clamps length', () => {
  const out = sanitizeTurn('hola   mundo\n\n   con   espacios');
  assert.strictEqual(out, 'hola mundo con espacios');
});

test('vecToLiteral: produces pgvector literal', () => {
  assert.strictEqual(vecToLiteral([1, 2, 3]), '[1,2,3]');
  assert.strictEqual(vecToLiteral('not array'), null);
});

test('daysSince: returns large number for unknown date', () => {
  assert.strictEqual(daysSince(null), Infinity);
});

test('relativeAge: maps days to Spanish phrasing', () => {
  assert.strictEqual(relativeAge(0.5), 'hoy');
  assert.strictEqual(relativeAge(1.5), 'ayer');
  assert.strictEqual(relativeAge(5), 'hace 5 días');
  assert.strictEqual(relativeAge(20), 'hace 3 semanas');
  assert.strictEqual(relativeAge(120), 'hace 4 meses');
});

test('contentHash: stable and length-32 hex', () => {
  const a = contentHash('hola');
  const b = contentHash('hola');
  assert.strictEqual(a, b);
  assert.ok(/^[0-9a-f]{64}$/.test(a));
});

test('indexTurn: refuses when params missing', async () => {
  const r = await indexTurn({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing_params');
});

test('indexTurn: refuses turn shorter than 30 chars', async () => {
  const prisma = fakePrisma();
  const r = await indexTurn({
    userId: 'u1', chatId: 'c1', role: 'user', content: 'hola', embedder: fakeEmbedder(), prismaClient: prisma,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'too_short');
  assert.strictEqual(prisma.insertions.length, 0);
});

test('indexTurn: persists user turn with category=conversation-turn-user', async () => {
  const prisma = fakePrisma();
  const r = await indexTurn({
    userId: 'u1', chatId: 'c1', role: 'user',
    content: 'Necesito un contrato de servicios profesionales en docx con cláusula de confidencialidad',
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.category, CATEGORY_USER);
  assert.strictEqual(prisma.insertions.length, 1);
  const args = prisma.insertions[0].args;
  // user_id, content, hash, vector_literal, category, importance, confidence, source
  assert.strictEqual(args[0], 'u1');
  assert.strictEqual(args[4], CATEGORY_USER);
  assert.strictEqual(args[7], 'chat:c1');
});

test('indexTurn: persists assistant turn with category=conversation-turn-assistant', async () => {
  const prisma = fakePrisma();
  const r = await indexTurn({
    userId: 'u1', chatId: 'c1', role: 'assistant',
    content: 'Claro, te genero un contrato profesional. Aquí va el documento completo en docx ...',
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.category, CATEGORY_ASSISTANT);
  assert.strictEqual(prisma.insertions[0].args[4], CATEGORY_ASSISTANT);
});

test('indexTurn: returns embed_error on embedder failure', async () => {
  const prisma = fakePrisma();
  const failingEmbedder = async () => { throw new Error('embed boom'); };
  const r = await indexTurn({
    userId: 'u1', chatId: 'c1', role: 'user',
    content: 'soy abogado y necesito un contrato de servicios profesionales largo',
    embedder: failingEmbedder, prismaClient: prisma,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'embed_error');
});

test('recallSimilarTurns: returns [] when feature disabled', async () => {
  delete process.env.ENABLE_CROSS_CHAT_RECALL;
  const prisma = fakePrisma({
    queryRows: [{ content: 'pregunta pasada', cosine: 0.9, createdAt: new Date().toISOString(), source: 'chat:old' }],
  });
  const r = await recallSimilarTurns({
    userId: 'u1', currentPrompt: 'pregunta similar', embedder: fakeEmbedder(), prismaClient: prisma,
  });
  assert.deepStrictEqual(r, []);
});

test('recallSimilarTurns: returns [] for short prompt', async () => {
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  const prisma = fakePrisma();
  const r = await recallSimilarTurns({
    userId: 'u1', currentPrompt: 'hola', embedder: fakeEmbedder(), prismaClient: prisma,
  });
  assert.deepStrictEqual(r, []);
});

test('recallSimilarTurns: filters by similarity threshold', async () => {
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  const prisma = fakePrisma({
    queryRows: [
      { content: 'pregunta similar 1', cosine: 0.9, createdAt: new Date().toISOString(), source: 'chat:c1', category: CATEGORY_USER },
      { content: 'pregunta no tanto', cosine: 0.5, createdAt: new Date().toISOString(), source: 'chat:c2', category: CATEGORY_USER },
    ],
  });
  const r = await recallSimilarTurns({
    userId: 'u1',
    currentPrompt: 'una pregunta lo suficientemente larga',
    minSimilarity: 0.78,
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].question, 'pregunta similar 1');
  assert.strictEqual(r[0].chatId, 'c1');
});

test('recallSimilarTurns: excludes excludeChatId', async () => {
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  const prisma = fakePrisma({
    queryRows: [
      { content: 'q1', cosine: 0.9, createdAt: new Date().toISOString(), source: 'chat:current', category: CATEGORY_USER },
      { content: 'q2', cosine: 0.85, createdAt: new Date().toISOString(), source: 'chat:other', category: CATEGORY_USER },
    ],
  });
  const r = await recallSimilarTurns({
    userId: 'u1',
    currentPrompt: 'pregunta razonablemente larga aquí',
    excludeChatId: 'current',
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].chatId, 'other');
});

test('recallSimilarTurns: pairs question with the assistant reply when available', async () => {
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  const prisma = fakePrisma({
    queryRows: [
      { content: '¿qué es OAuth?', cosine: 0.9, createdAt: new Date().toISOString(), source: 'chat:c1', category: CATEGORY_USER },
    ],
    replyMap: { c1: 'OAuth es un protocolo de autorización...' },
  });
  const r = await recallSimilarTurns({
    userId: 'u1',
    currentPrompt: 'puedes explicarme oauth otra vez por favor',
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.strictEqual(r.length, 1);
  assert.ok(r[0].answer.includes('OAuth es un protocolo'));
});

test('recallSimilarTurns: empty on prisma query error', async () => {
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  const prisma = {
    $executeRawUnsafe: async () => 0,
    $queryRawUnsafe: async () => { throw new Error('db down'); },
  };
  const r = await recallSimilarTurns({
    userId: 'u1',
    currentPrompt: 'pregunta larga válida para procesamiento',
    embedder: fakeEmbedder(),
    prismaClient: prisma,
  });
  assert.deepStrictEqual(r, []);
});

test('buildCrossChatBlock: empty for no turns', () => {
  assert.strictEqual(buildCrossChatBlock([]), '');
  assert.strictEqual(buildCrossChatBlock(null), '');
});

test('buildCrossChatBlock: renders inert tags with similarity and age', () => {
  const block = buildCrossChatBlock([
    { question: '¿qué es OAuth?', answer: 'OAuth es...', similarity: 0.91, daysAgo: 5, chatId: 'c1' },
  ]);
  assert.ok(block.includes('CONVERSACIONES PASADAS RELACIONADAS'));
  assert.ok(block.includes('<previous_conversation_1'));
  assert.ok(block.includes('similarity=0.91'));
  assert.ok(block.includes('hace 5 días'));
  assert.ok(block.includes('USUARIO PREGUNTÓ:'));
  assert.ok(block.includes('ASISTENTE RESPONDIÓ:'));
});

test('buildCrossChatBlock: omits assistant line when answer missing', () => {
  const block = buildCrossChatBlock([
    { question: '¿qué es OAuth?', answer: null, similarity: 0.91, daysAgo: 5, chatId: 'c1' },
  ]);
  assert.ok(block.includes('USUARIO PREGUNTÓ:'));
  assert.ok(!block.includes('ASISTENTE RESPONDIÓ:'));
});

test('indexTurn and recallSimilarTurns accept Float32Array embeddings (rag.embed contract)', async () => {
  const cc = require('../src/services/cross-chat-retrieval');
  const prev = process.env.ENABLE_CROSS_CHAT_RECALL;
  process.env.ENABLE_CROSS_CHAT_RECALL = 'true';
  try {
    const executed = [];
    const fakePrisma = {
      $executeRawUnsafe: async (...args) => { executed.push(args); return 1; },
      $queryRawUnsafe: async () => [],
    };
    const f32Embedder = async (texts) => texts.map(() => Float32Array.from([0.1, 0.2, 0.3]));
    const res = await cc.indexTurn({
      userId: 'u1', chatId: 'c1', role: 'user',
      content: 'este es un turno suficientemente largo para ser indexado en memoria',
      embedder: f32Embedder, prismaClient: fakePrisma,
    });
    assert.equal(res.ok, true, `Float32Array embedding must index (got ${JSON.stringify(res)})`);
    assert.equal(executed.length, 1);
    assert.match(executed[0][4], /^\[0\.1[0-9]*,0\.2/, 'vector literal built from typed array');

    const recall = await cc.recallSimilarTurns({
      userId: 'u1', currentPrompt: 'pregunta de prueba suficientemente larga',
      embedder: f32Embedder, prismaClient: fakePrisma,
    });
    assert.deepEqual(recall, [], 'query path tolerates typed arrays without throwing');
  } finally {
    if (prev === undefined) delete process.env.ENABLE_CROSS_CHAT_RECALL;
    else process.env.ENABLE_CROSS_CHAT_RECALL = prev;
  }
});
