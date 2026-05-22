/**
 * Auth integration tests — register, login, me, logout, refresh.
 *
 * Mocks Prisma and bcrypt so these tests run without a database.
 * The route handlers in routes/auth.js are tested with real
 * express-validator rules and JWT signing.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = require('../src/config/database');
const { buildRouteTestApp, reloadModule } = require('./http-test-utils');
const rateLimitStore = require('../src/middleware/rate-limit-store');

// ── Seed JWT secret ─────────────────────────────────────────────

const JWT_SECRET = 'test-auth-integration-jwt-secret-at-least-32-chars!!';
process.env.JWT_SECRET = JWT_SECRET;

// Force the rate-limit store to its in-memory mode so each test can
// reset it via `_resetForTests()` between runs. Otherwise we'd share a
// real Redis ZSET with every other test process (and previous runs),
// which is what made these tests intermittently 429 on validation
// failures unrelated to the actual rate-limit feature under test.
process.env.RATE_LIMIT_STORE = 'memory';

// ── Helpers ─────────────────────────────────────────────────────

const VALID_USER = {
  name: 'Test User',
  email: 'test@example.com',
  password: 'secret123',
};

function mockPrisma() {
  const store = {
    users: [],
    sessions: [],
    nextId: 1,
  };

  const findUserByEmail = (email) =>
    store.users.find((u) => u.email === email);

  const findUserById = (id) =>
    store.users.find((u) => u.id === id);

  const findSessionByToken = (token) =>
    store.sessions.find((s) => s.token === token);

  prisma.user.findUnique = async ({ where }) => {
    if (where.email) return findUserByEmail(where.email) || null;
    if (where.id) return findUserById(where.id) || null;
    return null;
  };

  prisma.user.create = async ({ data }) => {
    const user = {
      id: String(store.nextId++),
      ...data,
      isAdmin: false,
      plan: 'FREE',
      apiUsage: 0,
      monthlyCallLimit: 3,
      monthlyLimit: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.users.push(user);
    return { ...user };
  };

  prisma.session.create = async ({ data }) => {
    const session = { id: String(store.nextId++), ...data };
    store.sessions.push(session);
    return session;
  };

  prisma.session.findUnique = async ({ where }) => {
    return findSessionByToken(where.token) || null;
  };

  prisma.session.delete = async ({ where }) => {
    const idx = store.sessions.findIndex((s) => s.id === where.id);
    if (idx !== -1) store.sessions.splice(idx, 1);
  };

  prisma.session.deleteMany = async ({ where }) => {
    const before = store.sessions.length;
    for (let i = store.sessions.length - 1; i >= 0; i--) {
      const session = store.sessions[i];
      if (where.token && session.token !== where.token) continue;
      if (where.userId && session.userId !== where.userId) continue;
      store.sessions.splice(i, 1);
    }
    return { count: before - store.sessions.length };
  };

  prisma.session.findFirst = async ({ where }) => {
    return store.sessions.find((s) => s.userId === where.userId) || null;
  };

  return store;
}

// ── Tests ───────────────────────────────────────────────────────

describe('auth · registration', () => {
  let store;

  beforeEach(() => {
    rateLimitStore._resetForTests();
    store = mockPrisma();
  });

  it('registers a new user and returns token + user (no password)', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_USER)
      .expect(201);

    assert.equal(res.body.user.name, VALID_USER.name);
    assert.equal(res.body.user.email, VALID_USER.email);
    assert.equal(res.body.user.password, undefined); // never leaked
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.plan, 'FREE');
    assert.equal(res.body.user.monthlyCallLimit, 3);
  });

  it('rejects duplicate email', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    // First registration succeeds
    await request(app).post('/api/auth/register').send(VALID_USER).expect(201);

    // Duplicate is rejected
    const res = await request(app)
      .post('/api/auth/register')
      .send(VALID_USER)
      .expect(400);

    assert.equal(res.body.error, 'User already exists');
  });

  it('rejects short name (< 2 chars)', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, name: 'A' })
      .expect(400);

    assert(res.body.errors || res.body.error);
  });

  it('rejects invalid email', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, email: 'not-an-email' })
      .expect(400);

    assert(res.body.errors || res.body.error);
  });

  it('rejects short password (< 6 chars)', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, password: '12345' })
      .expect(400);

    assert(res.body.errors || res.body.error);
  });

  it('rejects missing fields', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/register')
      .send({})
      .expect(400);

    assert(res.body.errors || res.body.error);
  });
});

describe('auth · login', () => {
  let store;

  beforeEach(async () => {
    rateLimitStore._resetForTests();
    store = mockPrisma();

    // Pre-register a user with a known password
    const hashed = await bcrypt.hash(VALID_USER.password, 4);
    store.users.push({
      id: 'login-test-user',
      name: VALID_USER.name,
      email: VALID_USER.email,
      password: hashed,
      plan: 'FREE',
      isAdmin: false,
      monthlyCallLimit: 3,
      monthlyLimit: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('logs in with correct credentials', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: VALID_USER.password })
      .expect(200);

    assert.equal(res.body.user.email, VALID_USER.email);
    assert.equal(typeof res.body.token, 'string');
  });

  it('rejects wrong password', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: 'wrong-password' })
      .expect(401);

    assert(res.body.error);
  });

  it('rejects unknown email', async () => {
    const app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'unknown@example.com', password: 'any-password' })
      .expect(401);

    assert(res.body.error);
  });
});

describe('auth · me endpoint', () => {
  let store;
  let app;
  let token;
  const testUser = { ...VALID_USER, id: 'me-test-user' };

  beforeEach(async () => {
    rateLimitStore._resetForTests();
    store = mockPrisma();

    const hashed = await bcrypt.hash(testUser.password, 4);
    store.users.push({
      id: testUser.id,
      name: testUser.name,
      email: testUser.email,
      password: hashed,
      isAdmin: false,
      isSuperAdmin: false,
      plan: 'PRO',
      monthlyCallLimit: 100,
      monthlyLimit: 500000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    token = jwt.sign(
      { userId: testUser.id, id: testUser.id },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    store.sessions.push({
      id: 'me-test-session',
      userId: testUser.id,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      user: store.users[0],
    });

    app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
  });

  it('returns current user profile with valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The /me endpoint wraps the user in { user: ... }
    assert.equal(res.body.user.email, testUser.email);
    assert.equal(res.body.user.plan, 'PRO');
    assert.equal(res.body.user.password, undefined);
    // Convenience boolean derived from emailVerifiedAt. The mocked user
    // above has no emailVerifiedAt set, so the flag should be false.
    assert.equal(res.body.emailVerified, false);
  });

  it('exposes emailVerified=true when emailVerifiedAt is set', async () => {
    store.users[0].emailVerifiedAt = new Date('2026-01-01T00:00:00Z');

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(res.body.emailVerified, true);
  });

  it('rejects request without token', async () => {
    await request(app)
      .get('/api/auth/me')
      .expect(401);
  });

  it('rejects request with invalid token', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid-token')
      .expect(403); // auth middleware returns 403 for invalid tokens
  });
});

describe('auth · logout', () => {
  let store;
  let app;
  let token;

  beforeEach(async () => {
    rateLimitStore._resetForTests();
    store = mockPrisma();

    const hashed = await bcrypt.hash(VALID_USER.password, 4);
    store.users.push({
      id: 'logout-test-user',
      name: VALID_USER.name,
      email: VALID_USER.email,
      password: hashed,
      plan: 'FREE',
      monthlyCallLimit: 3,
      monthlyLimit: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    token = jwt.sign(
      { userId: 'logout-test-user', id: 'logout-test-user' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    store.sessions.push({
      id: 'logout-test-session',
      userId: 'logout-test-user',
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    app = buildRouteTestApp('/api/auth', reloadModule('../src/routes/auth'));
  });

  it('logs out successfully', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.equal(res.body.message, 'Logged out successfully');
  });

  it('rejects logout without authentication', async () => {
    await request(app)
      .post('/api/auth/logout')
      .expect(401);
  });
});
