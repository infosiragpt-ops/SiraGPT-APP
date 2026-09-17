'use strict';

// GET/POST /api/codex/projects/by-chat/:chatId — contrato HTTP con el router
// real y servicios falsos (mismo patrón offline que codex-route-contract).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, res, next) {
    if (!req.headers.authorization) return res.status(401).json({ error: 'unauthenticated' });
    req.user = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
    return next();
  },
});

const bindingCalls = [];
const restoreBinding = mockResolvedModule(require.resolve('../src/services/codex/project-chat-binding'), {
  findProjectForChat: async (args) => {
    bindingCalls.push(['find', args.chatId]);
    if (args.chatId === 'chat-1') return { id: 'p1', name: 'A', status: 'ready' };
    return null;
  },
  findOrCreateProjectForChat: async (args) => {
    bindingCalls.push(['ensure', args.chatId]);
    if (args.chatId === 'bad!') {
      const err = new Error('chatId inválido.');
      err.status = 400;
      err.code = 'invalid_chat_id';
      throw err;
    }
    return { project: { id: 'p9', name: args.name || 'Mi app web', status: 'ready' }, reused: args.chatId === 'chat-1' };
  },
});

const codexRoutes = require('../src/routes/codex');

after(() => {
  restoreAuth();
  restoreBinding();
  delete process.env.CODEX_AGENT_V2;
});
beforeEach(() => {
  process.env.CODEX_AGENT_V2 = '1';
  bindingCalls.length = 0;
});

function app() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/codex', codexRoutes);
  return a;
}

const AUTH = { Authorization: 'Bearer test' };

test('GET by-chat devuelve el proyecto vinculado', async () => {
  const res = await request(app()).get('/api/codex/projects/by-chat/chat-1').set(AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.project.id, 'p1');
  assert.equal(res.body.chatId, 'chat-1');
});

test('GET by-chat sin proyecto ⇒ 404 project_not_found', async () => {
  const res = await request(app()).get('/api/codex/projects/by-chat/chat-9').set(AUTH);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'project_not_found');
});

test('GET by-chat sin auth ⇒ 401', async () => {
  const res = await request(app()).get('/api/codex/projects/by-chat/chat-1');
  assert.equal(res.status, 401);
});

test('GET by-chat con chatId inválido ⇒ 404 (no filtra nada)', async () => {
  const res = await request(app()).get('/api/codex/projects/by-chat/..%2F..').set(AUTH);
  assert.equal(res.status, 404);
});

test('POST by-chat crea (201) o reutiliza (200)', async () => {
  const created = await request(app()).post('/api/codex/projects/by-chat/chat-9').set(AUTH).send({});
  assert.equal(created.status, 201);
  assert.equal(created.body.reused, false);
  assert.equal(created.body.project.id, 'p9');

  const reused = await request(app()).post('/api/codex/projects/by-chat/chat-1').set(AUTH).send({ name: 'Tienda' });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.reused, true);
});

test('POST by-chat propaga errores del binding con su código', async () => {
  const res = await request(app()).post('/api/codex/projects/by-chat/bad!').set(AUTH).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_chat_id');
});

test('POST by-chat valida el nombre', async () => {
  const res = await request(app()).post('/api/codex/projects/by-chat/chat-9').set(AUTH).send({ name: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
});
