'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

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
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {
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
    .send({ prompt: 'Lanzamiento de producto', days: 5, platforms: ['instagram', 'linkedin'] });

  assert.equal(res.status, 201);
  assert.equal(calls.create, 0, 'must not call create() per row');
  assert.equal(calls.createManyAndReturn.length, 1, 'must call createManyAndReturn exactly once');
  assert.equal(calls.createManyAndReturn[0].length, 5, 'one row per day');
  assert.ok(res.body.batchId, 'response carries a batchId');
  assert.equal(res.body.posts.length, 5);
  assert.ok(res.body.posts.every((p) => p.id), 'every returned post has an id');
});

test('POST /series rejects an unsupported-only platform set', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/social-posts/series')
    .send({ prompt: 'Hola mundo', days: 2, platforms: ['myspace'] });
  assert.equal(res.status, 400);
});
