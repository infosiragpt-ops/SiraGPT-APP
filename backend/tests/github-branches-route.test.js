'use strict';

// GET /api/github/repos/:owner/:repo/branches — selector de rama para el repo
// vinculado a un chat de /agentes (Etapa 6). Sin red: github-api.service se
// stubea; el router real se monta con auth falsa.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// routes/github.js carga utils/encryption, que aborta el proceso sin clave.
const prevEncryptionKey = process.env.ENCRYPTION_KEY;
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

let authUser = { id: 'u-1' };
const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) {
    req.user = authUser;
    next();
  },
});

const state = { calls: [], result: null, error: null };
const realGithubApi = require('../src/services/github/github-api.service');
const restoreGithubApi = mockResolvedModule(require.resolve('../src/services/github/github-api.service'), {
  ...realGithubApi,
  async listBranches(userId, owner, repo, opts) {
    state.calls.push([userId, owner, repo, opts]);
    if (state.error) throw state.error;
    return state.result;
  },
});

const githubRoutes = require('../src/routes/github');

after(() => {
  restoreAuth();
  restoreGithubApi();
  if (prevEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = prevEncryptionKey;
});

beforeEach(() => {
  authUser = { id: 'u-1' };
  state.calls.length = 0;
  state.result = null;
  state.error = null;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/github', githubRoutes);
  return app;
}

test('devuelve defaultBranch + branches con la cuenta del usuario y sin caché', async () => {
  state.result = {
    defaultBranch: 'production-main',
    branches: [
      { name: 'production-main', protected: true, commitSha: 'abc' },
      { name: 'feat/x', protected: false, commitSha: 'def' },
    ],
  };
  const res = await request(buildApp()).get('/api/github/repos/acme/app/branches?per_page=50');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.owner, 'acme');
  assert.equal(res.body.repo, 'app');
  assert.equal(res.body.defaultBranch, 'production-main');
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.branches.map((b) => b.name), ['production-main', 'feat/x']);
  assert.deepEqual(state.calls, [['u-1', 'acme', 'app', { perPage: '50' }]]);
});

test('owner/repo inválidos → 400 sin llamar a GitHub', async () => {
  const res = await request(buildApp()).get('/api/github/repos/..%2Fetc/app/branches');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid_name');
  assert.equal(state.calls.length, 0);
});

test('GitHub no conectado → 409 github_not_connected (normalizeError)', async () => {
  const err = new Error('GitHub is not connected for this user');
  err.status = 409;
  err.code = 'github_not_connected';
  state.error = err;
  const res = await request(buildApp()).get('/api/github/repos/acme/app/branches');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'github_not_connected');
});

test('repo inexistente o sin acceso → 404 github_not_found', async () => {
  const err = new Error('Not Found');
  err.status = 404;
  state.error = err;
  const res = await request(buildApp()).get('/api/github/repos/acme/ghost/branches');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'github_not_found');
});
