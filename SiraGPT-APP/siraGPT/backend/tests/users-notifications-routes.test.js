'use strict';

/**
 * Ratchet 45 — /api/users/me/notifications route tests.
 *
 * Boots the users router with stub auth + in-memory Prisma, exercises
 * the GET list / POST :id/read / POST read-all endpoints end-to-end.
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
  rows: [],
  autoId: 0,
};

function seed(rows) {
  state.rows = rows.map((r) => ({
    id: r.id || `n${++state.autoId}`,
    userId: r.userId,
    type: r.type || 't',
    title: r.title || '',
    message: r.message || '',
    severity: r.severity || 'info',
    read: !!r.read,
    readAt: r.readAt || null,
    metadata: r.metadata || null,
    createdAt: r.createdAt || new Date(Date.now() + state.autoId),
  }));
}

const authMock = {
  authenticateToken: (req, _res, next) => { req.user = state.user; next(); },
};

const prismaMock = {
  notification: {
    findMany: async ({ where = {}, take, cursor, skip }) => {
      let out = state.rows.filter((r) => {
        for (const k of Object.keys(where)) {
          if (r[k] !== where[k]) return false;
        }
        return true;
      });
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
      if (cursor?.id) {
        const idx = out.findIndex((r) => r.id === cursor.id);
        if (idx >= 0) out = out.slice(idx + (skip || 0));
      }
      if (take) out = out.slice(0, take);
      return out;
    },
    count: async ({ where = {} }) => state.rows.filter((r) => {
      for (const k of Object.keys(where)) if (r[k] !== where[k]) return false;
      return true;
    }).length,
    updateMany: async ({ where = {}, data }) => {
      let count = 0;
      for (const r of state.rows) {
        let match = true;
        for (const k of Object.keys(where)) {
          if (r[k] !== where[k]) { match = false; break; }
        }
        if (match) { Object.assign(r, data); count += 1; }
      }
      return { count };
    },
  },
  user: { findUnique: async () => state.user, update: async () => state.user },
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

describe('GET /api/users/me/notifications', () => {
  beforeEach(() => {
    seed([
      { userId: 'u1', title: 'a', read: false },
      { userId: 'u1', title: 'b', read: true },
      { userId: 'u1', title: 'c', read: false },
      { userId: 'u2', title: 'd', read: false },
    ]);
  });

  test('lists own notifications with counts', async () => {
    const res = await call({ method: 'GET', urlPath: '/api/users/me/notifications' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 3);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.unreadCount, 2);
  });

  test('filter=unread returns only unread', async () => {
    const res = await call({ method: 'GET', urlPath: '/api/users/me/notifications?filter=unread' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    assert.ok(res.body.items.every((r) => !r.read));
  });

  test('limit + cursor paginate', async () => {
    const p1 = await call({ method: 'GET', urlPath: '/api/users/me/notifications?limit=2' });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.items.length, 2);
    assert.ok(p1.body.nextCursor);
    const p2 = await call({
      method: 'GET',
      urlPath: `/api/users/me/notifications?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    });
    assert.equal(p2.status, 200);
    assert.equal(p2.body.items.length, 1);
    assert.equal(p2.body.nextCursor, null);
  });
});

describe('POST /api/users/me/notifications/:id/read', () => {
  beforeEach(() => {
    seed([
      { id: 'n_a', userId: 'u1', title: 'a', read: false },
      { id: 'n_b', userId: 'u2', title: 'b', read: false },
    ]);
  });

  test('marks own notification read', async () => {
    const res = await call({ method: 'POST', urlPath: '/api/users/me/notifications/n_a/read' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const row = state.rows.find((r) => r.id === 'n_a');
    assert.equal(row.read, true);
    assert.ok(row.readAt);
  });

  test('404 when notification belongs to another user', async () => {
    const res = await call({ method: 'POST', urlPath: '/api/users/me/notifications/n_b/read' });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/users/me/notifications/read-all', () => {
  beforeEach(() => {
    seed([
      { id: 'n_a', userId: 'u1', read: false },
      { id: 'n_b', userId: 'u1', read: false },
      { id: 'n_c', userId: 'u1', read: true },
      { id: 'n_d', userId: 'u2', read: false },
    ]);
  });

  test('marks every unread row for the user only', async () => {
    const res = await call({ method: 'POST', urlPath: '/api/users/me/notifications/read-all' });
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 2);
    assert.equal(state.rows.find((r) => r.id === 'n_a').read, true);
    assert.equal(state.rows.find((r) => r.id === 'n_b').read, true);
    assert.equal(state.rows.find((r) => r.id === 'n_d').read, false);
  });
});
