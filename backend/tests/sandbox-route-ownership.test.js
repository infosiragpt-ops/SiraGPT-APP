/**
 * Sandbox route ownership + auth fail-closed tests.
 *
 * Proves the IDOR on /api/sandbox/session/:id (any authenticated user could
 * read/destroy/finalize/download another user's session) and that the
 * router's auth wiring fails closed when the primary auth mechanism is
 * absent (missing module or unexpected export shape).
 */

'use strict';

const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { describe, it, before, after } = require('node:test');

const ROUTER_PATH = require.resolve('../src/routes/sandbox');
const AUTH_PATH = require.resolve('../src/middleware/auth');

// ── injectable fake auth middleware ─────────────────────────────────────────

let currentUser = null; // e.g. { id: 'user-A' } | { id: 'user-B' } | null

const fakeRequireAuth = (req, _res, next) => {
  if (currentUser) req.user = currentUser;
  else if (currentUser === null && process.env.SANDBOX_TEST_ANON === '1') {
    // anonymous: leave req.user unset — endpoints must reject
  }
  next();
};

function makeCacheEntry(id, exports_) {
  const m = new Module(id);
  m.filename = id;
  m.loaded = true;
  m.exports = exports_;
  m.paths = Module._nodeModulePaths(path.dirname(id));
  return m;
}

let origAuthCache, origRouterCache;

function installAuthMock() {
  origAuthCache = require.cache[AUTH_PATH];
  origRouterCache = require.cache[ROUTER_PATH];
  require.cache[AUTH_PATH] = makeCacheEntry(AUTH_PATH, { requireAuth: fakeRequireAuth });
  delete require.cache[ROUTER_PATH];
}

function restoreAuthMock() {
  if (origAuthCache) require.cache[AUTH_PATH] = origAuthCache;
  else delete require.cache[AUTH_PATH];
  if (origRouterCache) require.cache[ROUTER_PATH] = origRouterCache;
  else delete require.cache[ROUTER_PATH];
}

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/sandbox', router);
  return app;
}

async function createSessionAs(app, userId) {
  currentUser = { id: userId };
  const res = await request(app).post('/api/sandbox/session').send({ filename: 'doc.txt' });
  assert.equal(res.status, 200, `create as ${userId} failed: ${res.text}`);
  assert.equal(res.body.ok, true);
  return res.body.sessionId;
}

// ── IDOR denial matrix ──────────────────────────────────────────────────────

describe('sandbox session ownership guards (IDOR)', () => {
  let app;
  let sessionIdA;
  let fileA;

  before(async () => {
    installAuthMock();
    const sandboxRoutes = require('../src/routes/sandbox');
    app = buildApp(sandboxRoutes);
    sessionIdA = await createSessionAs(app, 'user-A');
    // give the session a file so download/finalize paths are reachable
    const sm = require('../src/services/sandbox/session-manager');
    const sess = sm.getSession(sessionIdA);
    fileA = 'leak.txt';
    require('fs').writeFileSync(require('path').join(sess.workdir, fileA), 'secret-of-A');
  });

  after(() => {
    const sm = require('../src/services/sandbox/session-manager');
    if (sessionIdA) sm.destroySession(sessionIdA);
    restoreAuthMock();
  });

  it('owner can still read their own session', async () => {
    currentUser = { id: 'user-A' };
    const res = await request(app).get(`/api/sandbox/session/${sessionIdA}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.files, [fileA]);
  });

  it('user B gets 403 reading user A session', async () => {
    currentUser = { id: 'user-B' };
    const res = await request(app).get(`/api/sandbox/session/${sessionIdA}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('user B gets 403 deleting user A session', async () => {
    currentUser = { id: 'user-B' };
    const res = await request(app).delete(`/api/sandbox/session/${sessionIdA}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
    // and the session survives the denied delete
    const sm = require('../src/services/sandbox/session-manager');
    assert.notEqual(sm.getSession(sessionIdA), null, 'denied DELETE must not destroy the session');
  });

  it('user B gets 403 finalizing user A session', async () => {
    currentUser = { id: 'user-B' };
    const res = await request(app)
      .post(`/api/sandbox/session/${sessionIdA}/finalize`)
      .send({ filename: fileA });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('user B gets 403 downloading user A file', async () => {
    currentUser = { id: 'user-B' };
    const res = await request(app).get(`/api/sandbox/session/${sessionIdA}/download/${fileA}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('anonymous request (no req.user) is rejected with 401 user_required', async () => {
    currentUser = null;
    const res = await request(app).get(`/api/sandbox/session/${sessionIdA}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'user_required');
  });

  it('nonexistent session id still returns 404 for the owner', async () => {
    currentUser = { id: 'user-A' };
    const res = await request(app).get('/api/sandbox/session/deadbeef0000000000000000');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'session_not_found');
  });
});

// ── auth fail-closed wiring ────────────────────────────────────────────────

describe('sandbox router auth fail-closed', () => {
  it('throws when the auth module cannot be required', () => {
    const { __resolveAuthMiddleware } = require(ROUTER_PATH);
    const boom = () => { throw new Error('MODULE_NOT_FOUND: ../middleware/auth'); };
    assert.throws(
      () => __resolveAuthMiddleware(boom),
      /auth middleware unavailable.*refusing to mount/,
      'resolver must fail closed when auth middleware cannot load',
    );
  });

  it('throws when auth exports no recognizable shape', () => {
    const { __resolveAuthMiddleware } = require(ROUTER_PATH);
    assert.throws(
      () => __resolveAuthMiddleware(() => ({ somethingElse: true })),
      /no recognizable shape.*refusing to mount/,
      'resolver must fail closed on unexpected export shape',
    );
    assert.throws(
      () => __resolveAuthMiddleware(() => null),
      /refusing to mount/,
      'resolver must fail closed on null exports',
    );
  });
});
