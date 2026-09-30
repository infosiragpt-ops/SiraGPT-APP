'use strict';

// Vínculo chat↔proyecto (MVP programación web en /agentes): el chatId vive
// en `brief` sin migración. Tests con dobles en memoria, sin DB real.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const binding = require('../src/services/codex/project-chat-binding');

function makeDb(rows = []) {
  return {
    chat: { findFirst: async ({ where }) => where.userId === 'u1' && /^chat-|^c1$/.test(where.id) ? { id: where.id } : null },
    codexProject: {
      findMany: async ({ where }) => rows.filter((r) => r.userId === where.userId && r.brief?.chatId === where.brief.equals),
    },
  };
}

function makeProjects(store) {
  return {
    getProject: async ({ userId, id }) => {
      const hit = store.find((p) => p.id === id && p.userId === userId);
      return hit ? { ...hit } : null;
    },
    createProject: async ({ userId, name, brief }) => {
      const project = { id: `p${store.length + 1}`, userId, name, brief: brief || null, status: 'ready' };
      store.push(project);
      return { ...project };
    },
  };
}

test('cleanChatId acepta cuid y rechaza basura', () => {
  assert.equal(binding.cleanChatId('cmabc123XYZ-_'), 'cmabc123XYZ-_');
  assert.equal(binding.cleanChatId(''), null);
  assert.equal(binding.cleanChatId(null), null);
  assert.equal(binding.cleanChatId('../x'), null);
  assert.equal(binding.cleanChatId('a b'), null);
  assert.equal(binding.cleanChatId('x'.repeat(65)), null);
});

test('briefChatId extrae solo strings', () => {
  assert.equal(binding.briefChatId({ chatId: 'c1' }), 'c1');
  assert.equal(binding.briefChatId(null), null);
  assert.equal(binding.briefChatId([]), null);
  assert.equal(binding.briefChatId({ chatId: 42 }), null);
  assert.equal(binding.briefChatId({}), null);
});

test('findProjectForChat resuelve por brief.chatId del mismo usuario', async () => {
  const store = [
    { id: 'p1', userId: 'u1', name: 'A', brief: { chatId: 'chat-1', source: 'agentes' }, status: 'ready' },
    { id: 'p2', userId: 'u1', name: 'B', brief: null, status: 'ready' },
  ];
  const db = makeDb([
    { id: 'p1', userId: 'u1', brief: { chatId: 'chat-1', source: 'agentes' } },
    { id: 'p2', userId: 'u1', brief: null },
  ]);
  const projects = makeProjects(store);
  const hit = await binding.findProjectForChat({ userId: 'u1', chatId: 'chat-1', db, projects });
  assert.equal(hit?.id, 'p1');
  const miss = await binding.findProjectForChat({ userId: 'u1', chatId: 'chat-9', db, projects });
  assert.equal(miss, null);
});

test('findProjectForChat nunca resuelve proyecto de otro usuario', async () => {
  const store = [{ id: 'p1', userId: 'u1', name: 'A', brief: { chatId: 'chat-1' }, status: 'ready' }];
  const db = makeDb([{ id: 'p1', userId: 'u1', brief: { chatId: 'chat-1' } }]);
  const projects = makeProjects(store);
  const hit = await binding.findProjectForChat({ userId: 'u2', chatId: 'chat-1', db, projects });
  assert.equal(hit, null);
});

test('findOrCreateProjectForChat reutiliza y crea con brief', async () => {
  const store = [];
  const db = makeDb([]);
  const projects = makeProjects(store);
  const first = await binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'chat-1', name: 'Mi app', db, projects });
  assert.equal(first.reused, false);
  assert.equal(first.project.brief.chatId, 'chat-1');
  db.codexProject.findMany = async ({ where }) => store
    .filter((p) => p.userId === where.userId)
    .map((p) => ({ id: p.id, userId: p.userId, brief: p.brief }));
  const second = await binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'chat-1', db, projects });
  assert.equal(second.reused, true);
  assert.equal(second.project.id, first.project.id);
});

test('findOrCreateProjectForChat valida entradas', async () => {
  const projects = makeProjects([]);
  const byCode = (code) => (err) => {
    assert.equal(err?.code, code);
    return true;
  };
  await assert.rejects(
    binding.findOrCreateProjectForChat({ userId: null, chatId: 'c1', projects }),
    byCode('user_required'),
  );
  await assert.rejects(
    binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'no válida!', projects }),
    byCode('invalid_chat_id'),
  );
  await assert.rejects(
    binding.findOrCreateProjectForChat({ userId: 'u1', chatId: null, projects }),
    byCode('invalid_chat_id'),
  );
});

test('store failure propagates instead of masquerading as an absent binding', async () => {
  const projects = makeProjects([]);
  await assert.rejects(binding.findProjectForChat({ userId: 'u1', chatId: 'c1', db: null, projects }), { code: 'codex_store_unavailable' });
  const db = makeDb();
  db.codexProject.findMany = async () => { throw new Error('db down'); };
  await assert.rejects(binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'c1', db, projects }), /db down/);
});


test('binding query finds an older chat beyond 50 projects and filters in the database', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, userId: 'u1', brief: { chatId: `chat-${i}` } }));
  let query;
  const db = makeDb(rows);
  const read = db.codexProject.findMany;
  db.codexProject.findMany = async (args) => { query = args; return read(args); };
  assert.equal(await binding.findProjectIdForChat({ userId: 'u1', chatId: 'chat-79', db }), 'p79');
  assert.deepEqual(query.where, { userId: 'u1', deletedAt: null, brief: { path: ['chatId'], equals: 'chat-79' } });
  assert.equal(query.take, 1);
});

test('binding creation refuses an unowned chat before allocating any workspace', async () => {
  const store = [], db = makeDb(), projects = makeProjects(store);
  await assert.rejects(binding.findOrCreateProjectForChat({ userId: 'u2', chatId: 'chat-1', db, projects }), { code: 'coding_chat_not_found' });
  assert.equal(store.length, 0);
});

test('concurrent create requests provision once, then reuse the durable binding', async () => {
  const store = [], db = makeDb(), projects = makeProjects(store);
  db.codexProject.findMany = async ({ where }) => store.filter((row) => row.userId === where.userId && row.brief.chatId === where.brief.equals);
  const create = projects.createProject;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let count = 0;
  projects.createProject = async (args) => { count++; entered(); await hold; return create(args); };
  const first = binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'chat-1', name: 'CRM', instructions: 'backend con login', db, projects });
  await started;
  const second = binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'chat-1', db, projects });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal(a.project.id, b.project.id);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(store[0].brief.instructions, 'frontend y backend');
  const afterRestart = await binding.findProjectForChat({ userId: 'u1', chatId: 'chat-1', db, projects });
  assert.equal(afterRestart.id, a.project.id);
});

test('production binding creation uses the PostgreSQL advisory transaction and its client', async () => {
  const store = [], db = makeDb(), projects = makeProjects(store), calls = [];
  const tx = makeDb();
  db.$queryRawUnsafe = () => { throw new Error('lock must run on transaction'); };
  db.$transaction = async (work) => { calls.push('transaction'); return work(tx); };
  tx.$queryRawUnsafe = async (sql, ...args) => { calls.push({ sql, args }); return [{ locked: 1 }]; };
  projects.createProject = async (args) => { assert.equal(args.db, tx); return { id: 'p1', status: 'ready', brief: args.brief }; };
  const result = await binding.findOrCreateProjectForChat({ userId: 'u1', chatId: 'chat-1', db, projects });
  assert.equal(result.project.id, 'p1');
  assert.equal(calls[0], 'transaction');
  assert.match(calls[1].sql, /WITH _lock.*pg_advisory_xact_lock/);
  assert.equal(calls[1].args.length, 2);
});
