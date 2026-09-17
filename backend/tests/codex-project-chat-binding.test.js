'use strict';

// Vínculo chat↔proyecto (MVP programación web en /agentes): el chatId vive
// en `brief` sin migración. Tests con dobles en memoria, sin DB real.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const binding = require('../src/services/codex/project-chat-binding');

function makeDb(rows = []) {
  return {
    codexProject: {
      findMany: async ({ where }) => rows.filter((r) => r.userId === where.userId),
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

test('sin store la búsqueda falla cerrado (null), no explota', async () => {
  const projects = makeProjects([]);
  const hit = await binding.findProjectForChat({ userId: 'u1', chatId: 'c1', db: null, projects });
  assert.equal(hit, null);
});
