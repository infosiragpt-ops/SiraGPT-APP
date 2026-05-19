'use strict';

/**
 * Ratchet 45 — PATCH /api/users/me/settings (notification opt-outs).
 *
 * Boots the users router with a stub auth middleware + an in-memory
 * Prisma fake. Verifies:
 *  - patch with valid notifications keys updates settings.notifications
 *  - unknown keys are dropped at the boundary
 *  - existing settings outside `notifications` are preserved
 *  - null value clears a category (back to default opt-in)
 *  - missing body / unknown-only body → 400
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const authPath = path.resolve(__dirname, '../src/middleware/auth.js');
const dbPath = path.resolve(__dirname, '../src/config/database.js');
const usersRoutePath = path.resolve(__dirname, '../src/routes/users.js');

const state = {
  user: { id: 'u1', email: 'u1@x.com', name: 'U1' },
  settings: null,
};

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  user: {
    findUnique: async () => ({ settings: state.settings }),
    update: async ({ data, select }) => {
      state.settings = data.settings;
      const out = {};
      if (select.settings) out.settings = state.settings;
      return out;
    },
  },
};

require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: authMock };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: prismaMock };

delete require.cache[usersRoutePath];
const usersRouter = require(usersRoutePath);

function call({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => {
            server.close();
            let json = null; try { json = buf ? JSON.parse(buf) : null; } catch { /* noop */ }
            resolve({ status: res.statusCode, body: json });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('PATCH /api/users/me/settings', () => {
  beforeEach(() => {
    state.settings = null;
  });

  test('sets a single opt-out flag and returns merged blob', async () => {
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: { invitations: false } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.notifications, { invitations: false });
    assert.ok(Array.isArray(res.body.categories));
    assert.deepEqual(
      state.settings.notifications,
      { invitations: false },
    );
  });

  test('preserves unrelated top-level settings keys', async () => {
    state.settings = { locale: 'es', theme: 'dark', notifications: { billing: false } };
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: { invitations: false } },
    });
    assert.equal(res.status, 200);
    assert.equal(state.settings.locale, 'es');
    assert.equal(state.settings.theme, 'dark');
    assert.deepEqual(state.settings.notifications, {
      billing: false,
      invitations: false,
    });
  });

  test('drops unknown notification keys at the boundary', async () => {
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: { invitations: false, bogus: true, evil: 'x' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.settings.notifications, { invitations: false });
    assert.equal('bogus' in state.settings.notifications, false);
  });

  test('null value clears an existing opt-out (back to default)', async () => {
    state.settings = { notifications: { invitations: false, billing: false } };
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: { invitations: null } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.notifications, { billing: false });
  });

  test('missing notifications body → 400', async () => {
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.ok(Array.isArray(res.body.categories));
  });

  test('patch with only unknown keys → 400', async () => {
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: { unknown1: true, bogus: false } },
    });
    assert.equal(res.status, 400);
  });

  test('array body for notifications → 400', async () => {
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: [{ invitations: false }] },
    });
    assert.equal(res.status, 400);
  });

  test('all five categories accepted', async () => {
    const patch = {
      invitations: false,
      role_changes: false,
      removal: false,
      ownership: false,
      billing: false,
    };
    const res = await call({
      method: 'PATCH',
      urlPath: '/api/users/me/settings',
      body: { notifications: patch },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.notifications, patch);
  });
});
