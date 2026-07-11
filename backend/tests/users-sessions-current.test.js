'use strict';

const { afterEach, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const prisma = require('../src/config/database');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');
const {
  hashSessionToken,
} = require('../src/services/auth/session-token-persistence');

describe('GET /api/users/sessions current-session matching', () => {
  let auth;
  let originalFindMany;
  let app;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'users-current-session-user' });
    originalFindMany = prisma.session.findMany;
    app = buildRouteTestApp('/api/users', reloadModule('../src/routes/users'));
  });

  afterEach(() => {
    prisma.session.findMany = originalFindMany;
    auth.restore();
  });

  async function listWithStoredToken(storedToken) {
    prisma.session.findMany = async () => [{
      id: 'listed-current-session',
      token: storedToken,
      createdAt: new Date('2026-07-11T20:00:00.000Z'),
      expiresAt: new Date('2026-07-12T20:00:00.000Z'),
    }];
    return request(app)
      .get('/api/users/sessions')
      .set('Authorization', auth.authHeader)
      .expect(200);
  }

  it('marks a compat-mode raw row as current', async () => {
    const response = await listWithStoredToken(auth.token);

    assert.equal(response.body.sessions.length, 1);
    assert.equal(response.body.sessions[0].current, true);
  });

  it('marks a hash-mode versioned row as current', async () => {
    const response = await listWithStoredToken(hashSessionToken(auth.token));

    assert.equal(response.body.sessions.length, 1);
    assert.equal(response.body.sessions[0].current, true);
  });
});
