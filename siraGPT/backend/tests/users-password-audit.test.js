/**
 * users-password-audit — verifies PUT /api/users/me/password writes a
 * `password_changed` audit row whose metadata carries:
 *   • a requestId (from req.requestId / X-Request-Id),
 *   • a salted SHA-256 hash of the caller IP (never the raw IP),
 *   • a parsed UA shape ({browser, os, device, raw}).
 *
 * Prisma is mocked, and we override the request id by setting
 * `X-Request-Id` since express's req.requestId is populated by a
 * middleware not present in this route-level test app.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');

const JWT_SECRET = 'test-password-audit-jwt-secret-at-least-32-chars!!';
process.env.JWT_SECRET = JWT_SECRET;
process.env.AUDIT_IP_HASH_SALT = 'unit-test-salt';

function mockPrisma() {
  const store = { users: [], sessions: [], auditRows: [] };

  prisma.user.findUnique = async ({ where }) => {
    if (where.id) return store.users.find((u) => u.id === where.id) || null;
    if (where.email) return store.users.find((u) => u.email === where.email) || null;
    return null;
  };
  prisma.user.update = async ({ where, data }) => {
    const u = store.users.find((x) => x.id === where.id);
    Object.assign(u, data);
    return u;
  };
  prisma.session.findUnique = async ({ where, include }) => {
    const s = store.sessions.find((x) => x.token === where.token) || null;
    if (!s) return null;
    if (include && include.user) {
      return { ...s, user: store.users.find((u) => u.id === s.userId) || null };
    }
    return s;
  };
  prisma.session.deleteMany = async () => ({ count: 0 });

  if (!prisma.auditLog) prisma.auditLog = {};
  prisma.auditLog.create = async ({ data }) => {
    store.auditRows.push(data);
    return data;
  };
  prisma.auditLog.findMany = async () => [];

  return store;
}

async function seedUser(store) {
  const password = 'oldpass123';
  const hashed = await bcrypt.hash(password, 4);
  const u = {
    id: 'user-password-audit',
    email: 'pwd@example.com',
    name: 'Pwd User',
    password: hashed,
    plan: 'FREE',
    isAdmin: false,
  };
  store.users.push(u);
  const token = jwt.sign({ userId: u.id, id: u.id }, JWT_SECRET, { expiresIn: '1h' });
  store.sessions.push({
    id: 'pwd-session',
    userId: u.id,
    token,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { user: u, token, currentPassword: password };
}

describe('PUT /api/users/password — audit metadata (ratchet 45)', () => {
  let store;
  let app;

  beforeEach(() => {
    store = mockPrisma();
    app = buildRouteTestApp('/api/users', reloadModule('../src/routes/users'));
  });

  it('writes a password_changed row with requestId, ipHash and parsed UA', async () => {
    const { token, currentPassword } = await seedUser(store);

    const res = await request(app)
      .put('/api/users/password')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'req-abc-123')
      .set(
        'User-Agent',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      )
      .send({ currentPassword, newPassword: 'newpass-strong-9' })
      .expect(200);

    assert.equal(res.body.message, 'Password updated successfully');

    // fire-and-forget — drain microtasks
    await new Promise((r) => setImmediate(r));

    const row = store.auditRows.find((r) => r.action === 'password_changed');
    assert.ok(row, 'expected password_changed audit row');
    assert.equal(row.actorId, 'user-password-audit');
    assert.equal(row.resourceType, 'user');

    const meta = row.metadata || {};
    assert.equal(meta.requestId, 'req-abc-123');

    // IP hash must be a short hex string and MUST NOT be the raw IP.
    assert.equal(typeof meta.ipHash, 'string');
    assert.match(meta.ipHash, /^[0-9a-f]{16}$/);

    // Parsed UA shape
    assert.ok(meta.ua && typeof meta.ua === 'object');
    assert.equal(meta.ua.browser, 'Chrome');
    assert.equal(meta.ua.os, 'macOS');
    assert.equal(meta.ua.device, 'desktop');

    // The helper must NOT have stamped raw ip/ua keys onto metadata.
    assert.equal(meta.ip, undefined);
    // (meta.ua is the parsed object; verifying it's an object above is enough)
  });

  it('still succeeds when the UA header is absent (parseUA returns Unknown)', async () => {
    const { token, currentPassword } = await seedUser(store);

    await request(app)
      .put('/api/users/password')
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', '')
      .send({ currentPassword, newPassword: 'newpass-strong-9' })
      .expect(200);

    await new Promise((r) => setImmediate(r));
    const row = store.auditRows.find((r) => r.action === 'password_changed');
    assert.ok(row);
    assert.equal(row.metadata.ua.browser, 'Unknown');
  });

  it('rejects wrong current password without writing an audit row', async () => {
    const { token } = await seedUser(store);

    await request(app)
      .put('/api/users/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'totally-wrong', newPassword: 'newpass-strong-9' })
      .expect(400);

    await new Promise((r) => setImmediate(r));
    const row = store.auditRows.find((r) => r.action === 'password_changed');
    assert.equal(row, undefined);
  });
});
