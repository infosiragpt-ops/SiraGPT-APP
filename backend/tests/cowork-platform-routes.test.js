'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '1'.repeat(64);

const { createCoworkPlatformRouter } = require('../src/routes/cowork-platform');
const { createCoworkAiControlRouter } = require('../src/routes/cowork-ai-control');

function authenticatedAs(userId) {
  return (req, _res, next) => {
    req.user = { id: userId };
    next();
  };
}

test('Cowork workspace routes conceal resources owned by another user', async () => {
  const prisma = {
    coworkWorkspace: {
      findFirst: async ({ where }) => (
        where.id === 'workspace-foreign' && where.userId === 'owner'
          ? { id: 'workspace-foreign', userId: 'owner', name: 'Private' }
          : null
      ),
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/cowork', createCoworkPlatformRouter({
    prisma,
    authenticateToken: authenticatedAs('attacker'),
  }));

  const response = await request(app).get('/api/cowork/workspaces/workspace-foreign');
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'workspace_not_found');
  assert.equal(JSON.stringify(response.body).includes('Private'), false);
});

test('POST /api/ai/steer resolves the active run inside the caller tenant', async () => {
  const calls = [];
  const run = {
    id: 'run-1',
    userId: 'u1',
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    status: 'running',
  };
  const prisma = {
    coworkRun: {
      findFirst: async ({ where }) => {
        calls.push(where);
        if (where.userId !== 'u1') return null;
        if (where.chatId && where.chatId !== 'chat-1') return null;
        if (where.id && where.id !== 'run-1') return null;
        return where.select ? { id: run.id } : { ...run };
      },
      update: async () => ({ ...run }),
    },
    coworkSteeringNote: {
      create: async ({ data }) => ({
        id: 'steer-1',
        status: 'queued',
        createdAt: new Date(),
        ...data,
      }),
    },
    agentAuditLog: {
      create: async ({ data }) => data,
    },
    $transaction: async (callback) => callback(prisma),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/ai', createCoworkAiControlRouter({
    prisma,
    authenticateToken: authenticatedAs('u1'),
  }));

  const response = await request(app)
    .post('/api/ai/steer')
    .send({ chatId: 'chat-1', note: 'Prioriza la tabla de riesgos' });
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.steering.runId, 'run-1');
  assert.ok(calls.every((where) => where.userId === 'u1'));
});

test('the production app mounts CSRF before Cowork mutation routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const csrfIndex = source.indexOf("app.use('/api/cowork', requireCsrf)");
  const routerIndex = source.indexOf("app.use('/api/cowork', createCoworkPlatformRouter())");
  assert.ok(csrfIndex > -1, 'Cowork CSRF middleware must be mounted');
  assert.ok(routerIndex > csrfIndex, 'Cowork router must be mounted after CSRF');
});
