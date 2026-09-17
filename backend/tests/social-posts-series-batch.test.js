'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const {
  socialResourceKeyForConnection,
} = require('../src/services/codex/company-resources');

const LINKEDIN_CONNECTION = {
  id: 'connection-linkedin',
  userId: 'u-test',
  platform: 'linkedin',
  accountId: 'account-linkedin',
  accessToken: 'sealed-token',
};
const LINKEDIN_KEY = socialResourceKeyForConnection(LINKEDIN_CONNECTION);

// Inject fakes for auth + db BEFORE requiring the router so the route runs in
// isolation (no real PrismaClient, no token verification).
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  children: [],
  paths: [],
  exports: { authenticateToken: (req, _res, next) => { req.user = { id: 'u-test' }; next(); } },
};

const dbPath = require.resolve('../src/config/database');
const calls = { create: 0, createManyAndReturn: [] };
let assignments = { [LINKEDIN_KEY]: 'marketing' };
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    codexProject: {
      findFirst: async ({ where }) => (
        where.id === 'workspace-a' && where.userId === 'u-test'
          ? {
            id: where.id,
            userId: where.userId,
            brief: {
              companyResources: {
                assignments: { ...assignments },
                pinned: [],
              },
            },
            companyLink: {
              project: { id: 'company-a', userId: where.userId, deletedAt: null },
            },
          }
          : null
      ),
    },
    socialConnection: {
      findMany: async () => [structuredClone(LINKEDIN_CONNECTION)],
    },
    scheduledPost: {
      create: async () => { calls.create += 1; return { id: 'x' }; },
      createManyAndReturn: async ({ data }) => {
        calls.createManyAndReturn.push(data);
        return data.map((d, i) => ({ id: `post-${i}`, ...d }));
      },
    },
  },
};

const router = require('../src/routes/social-posts');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/social-posts', router);
  return app;
}

test('POST /series batches inserts via createManyAndReturn (no per-row create)', async () => {
  calls.create = 0;
  calls.createManyAndReturn = [];
  const app = makeApp();
  const res = await request(app)
    .post('/api/social-posts/series')
    .send({
      prompt: 'Lanzamiento de producto',
      days: 5,
      platforms: ['linkedin'],
      workspaceId: 'workspace-a',
    });

  assert.equal(res.status, 201);
  assert.equal(calls.create, 0, 'must not call create() per row');
  assert.equal(calls.createManyAndReturn.length, 1, 'must call createManyAndReturn exactly once');
  assert.equal(calls.createManyAndReturn[0].length, 5, 'one row per day');
  assert.ok(res.body.batchId, 'response carries a batchId');
  assert.equal(res.body.posts.length, 5);
  assert.ok(res.body.posts.every((p) => p.id), 'every returned post has an id');
  assert.ok(
    calls.createManyAndReturn[0].every((row) => row.config.workspaceId === 'workspace-a'),
    'every row remains scoped to the authorized company',
  );
});

test('POST /series rejects an unsupported-only platform set', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/social-posts/series')
    .send({
      prompt: 'Hola mundo',
      days: 2,
      platforms: ['myspace'],
      workspaceId: 'workspace-a',
    });
  assert.equal(res.status, 400);
});

test('POST /series rejects unscoped and non-Marketing resources', async () => {
  const app = makeApp();
  const unscoped = await request(app)
    .post('/api/social-posts/series')
    .send({ prompt: 'Hola mundo', days: 2, platforms: ['linkedin'] });
  assert.equal(unscoped.status, 400);

  assignments = { [LINKEDIN_KEY]: 'growth-engines' };
  const denied = await request(app)
    .post('/api/social-posts/series')
    .send({
      prompt: 'Hola mundo',
      days: 2,
      platforms: ['linkedin'],
      workspaceId: 'workspace-a',
    });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'social_resource_not_assigned');
  assignments = { [LINKEDIN_KEY]: 'marketing' };
});
