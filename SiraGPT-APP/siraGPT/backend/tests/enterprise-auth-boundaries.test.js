const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('Enterprise route user isolation', () => {
  let auth;
  let enterpriseRoutes;

  beforeEach(() => {
    auth = installAuthSessionMock({ id: 'enterprise-user-a' });
    enterpriseRoutes = reloadModule('../src/routes/enterprise');
  });

  afterEach(() => {
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/enterprise', enterpriseRoutes);
  }

  test('memory endpoints ignore client-supplied userId and scope to req.user.id', async () => {
    const app = buildApp();

    const write = await request(app)
      .post('/api/enterprise/product-os/memory/turn')
      .set('Authorization', auth.authHeader)
      .send({
        userId: 'victim-user',
        role: 'user',
        content: 'private note stored under the authenticated user',
      });

    assert.equal(write.status, 200);
    assert.equal(write.body.ok, true);
    assert.equal(write.body.recent[0].content, 'private note stored under the authenticated user');

    auth.restore();
    auth = installAuthSessionMock({ id: 'enterprise-user-b' });

    const recall = await request(app)
      .post('/api/enterprise/product-os/memory/recall')
      .set('Authorization', auth.authHeader)
      .send({
        userId: 'enterprise-user-a',
        query: 'private note',
      });

    assert.equal(recall.status, 200);
    assert.equal(recall.body.ok, true);
    assert.deepEqual(recall.body.short_term, []);
  });
});
