const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const settings = require('../src/services/searchBrain/universal/settings');
const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('SearchBrain settings auth boundaries', () => {
  let auth;
  let previousDisablePrisma;

  beforeEach(async () => {
    previousDisablePrisma = process.env.SEARCH_BRAIN_SETTINGS_DISABLE_PRISMA;
    process.env.SEARCH_BRAIN_SETTINGS_DISABLE_PRISMA = '1';
    await settings.clear();
    auth = installAuthSessionMock();
  });

  afterEach(async () => {
    await settings.clear();
    auth.restore();
    if (previousDisablePrisma === undefined) delete process.env.SEARCH_BRAIN_SETTINGS_DISABLE_PRISMA;
    else process.env.SEARCH_BRAIN_SETTINGS_DISABLE_PRISMA = previousDisablePrisma;
  });

  test('universal settings cannot be read or written with x-user-id only', async () => {
    const app = buildRouteTestApp('/api/search-brain/universal', reloadModule('../src/routes/search-brain-universal'));

    const read = await request(app)
      .get('/api/search-brain/universal/settings')
      .set('x-user-id', auth.user.id);
    assert.equal(read.status, 401);
    assert.equal(read.body.error, 'Access token required');

    const write = await request(app)
      .post('/api/search-brain/universal/settings')
      .set('x-user-id', auth.user.id)
      .send({ region: 'spain' });
    assert.equal(write.status, 401);
    assert.equal(write.body.error, 'Access token required');
  });

  test('search-brain settings mutations require JWT auth', async () => {
    const app = buildRouteTestApp('/api/search-brain', reloadModule('../src/routes/search-brain'));

    const res = await request(app)
      .post('/api/search-brain/settings/region')
      .set('x-user-id', auth.user.id)
      .send({ region: 'spain' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
    assert.equal((await settings.get(auth.user.id)).region, 'global');
  });

  test('authenticated settings mutations are scoped to req.user.id', async () => {
    const app = buildRouteTestApp('/api/search-brain', reloadModule('../src/routes/search-brain'));

    const res = await request(app)
      .post('/api/search-brain/settings/region')
      .set('Authorization', auth.authHeader)
      .set('x-user-id', 'attacker-controlled-id')
      .send({ region: 'spain' });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { region: 'spain' });
    assert.equal((await settings.get(auth.user.id)).region, 'spain');
    assert.equal((await settings.get('attacker-controlled-id')).region, 'global');
  });
});
