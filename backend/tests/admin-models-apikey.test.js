'use strict';

/**
 * Admin → Modelos IA never echoes `AiModel.apiKey`. GET/POST/PUT/PATCH
 * answer `apiKeySet` instead (same contract as Admin → Conexiones), and a
 * PUT with an empty key keeps the stored one (null clears it).
 */

// In the repo this is `path.join(__dirname, '..')`; the env override only
// lets the scratch copy run against both trees.
const B = require('path').join(__dirname, '..');
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require(B + '/tests/http-test-utils');
const prisma = require(B + '/src/config/database');

const authStub = {
  authenticateToken(req, _res, next) {
    req.user = { id: 'super-1', isAdmin: true, isSuperAdmin: true };
    next();
  },
  requireAdmin(_req, _res, next) { next(); },
  requireSuperAdmin(_req, _res, next) { next(); },
};
const restoreAuth = mockResolvedModule(require.resolve(B + '/src/middleware/auth'), authStub);

const SECRET = 'sk-live-admin-models-must-not-leak-1234';
let rows = [];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require(B + '/src/routes/admin'));
  return app;
}

function project(row, args = {}) {
  if (args.select) {
    const out = {};
    for (const key of Object.keys(args.select)) if (args.select[key]) out[key] = row[key];
    return out;
  }
  const out = { ...row };
  for (const key of Object.keys(args.omit || {})) if (args.omit[key]) delete out[key];
  return out;
}

describe('admin model helpers', () => {
  const pub = () => require(B + '/src/services/ai-model-publication');

  test('toAdminModelView drops apiKey and reports apiKeySet', () => {
    const { toAdminModelView } = pub();
    const view = toAdminModelView({ id: 'm1', name: 'x', apiKey: SECRET });
    assert.equal('apiKey' in view, false);
    assert.equal(view.apiKeySet, true);
    assert.equal(toAdminModelView({ id: 'm2', apiKey: null }).apiKeySet, false);
    assert.equal(toAdminModelView({ id: 'm3', apiKey: '' }).apiKeySet, false);
    assert.equal(toAdminModelView(null), null);
  });

  test('normalizeModelApiKeyInput: empty keeps, null clears, string replaces', () => {
    const { normalizeModelApiKeyInput } = pub();
    assert.equal(normalizeModelApiKeyInput(undefined), undefined);
    assert.equal(normalizeModelApiKeyInput(''), undefined);
    assert.equal(normalizeModelApiKeyInput('   '), undefined);
    assert.equal(normalizeModelApiKeyInput(null), null);
    assert.equal(normalizeModelApiKeyInput('  sk-new  '), 'sk-new');
    assert.equal(normalizeModelApiKeyInput(42), undefined);
    assert.equal(normalizeModelApiKeyInput({ k: 1 }), undefined);
  });

  test('setAiModelActive never returns the stored key', async () => {
    const { setAiModelActive } = pub();
    const store = [{ id: 'm1', name: 'x', isActive: false, apiKey: SECRET }];
    const db = {
      aiModel: {
        async update({ where, data }) { const r = store.find((x) => x.id === where.id); Object.assign(r, data); return { ...r }; },
        async count({ where } = {}) { return where ? store.filter((r) => r.isActive === where.isActive).length : store.length; },
      },
    };
    const { model } = await setAiModelActive(db, { id: 'm1', isActive: true });
    assert.equal(JSON.stringify(model).includes(SECRET), false);
    assert.equal(model.apiKeySet, true);
    assert.equal(store[0].apiKey, SECRET, 'toggling never touches the stored key');
  });
});

describe('Admin → Modelos IA HTTP responses', () => {
  const originals = {};

  before(() => {
    const sync = require(B + '/src/services/model-sync-service');
    originals.ensureDefaultInactiveOnce = sync.ensureDefaultInactiveOnce;
    originals.ensureStaticCatalogModels = sync.ensureStaticCatalogModels;
    sync.ensureDefaultInactiveOnce = async () => ({});
    sync.ensureStaticCatalogModels = async () => ({});
    originals.userRoles = prisma.userRole.findMany;
    prisma.userRole.findMany = async () => [{
      role: { permissions: [
        { permission: { code: 'admin.models.read' } },
        { permission: { code: 'admin.models.manage' } },
      ] },
    }];
    originals.aiModel = {
      findMany: prisma.aiModel.findMany,
      create: prisma.aiModel.create,
      update: prisma.aiModel.update,
      count: prisma.aiModel.count,
    };
    prisma.aiModel.findMany = async (args = {}) => rows.map((r) => project(r, args));
    prisma.aiModel.create = async (args) => {
      const row = { id: `m${rows.length + 1}`, isActive: false, createdAt: new Date(), ...args.data };
      rows.push(row);
      return project(row, args);
    };
    prisma.aiModel.update = async (args) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) { const e = new Error('not found'); e.code = 'P2025'; throw e; }
      Object.assign(row, args.data);
      return project(row, args);
    };
    prisma.aiModel.count = async ({ where } = {}) => (
      where ? rows.filter((r) => r.isActive === where.isActive).length : rows.length
    );
  });

  after(() => {
    const sync = require(B + '/src/services/model-sync-service');
    sync.ensureDefaultInactiveOnce = originals.ensureDefaultInactiveOnce;
    sync.ensureStaticCatalogModels = originals.ensureStaticCatalogModels;
    prisma.userRole.findMany = originals.userRoles;
    Object.assign(prisma.aiModel, originals.aiModel);
    restoreAuth();
  });

  beforeEach(() => {
    rows = [
      { id: 'm1', name: 'gpt-x', displayName: 'GPT X', provider: 'OpenAI', type: 'TEXT', isActive: true, apiKey: SECRET, createdAt: new Date() },
      { id: 'm2', name: 'gpt-image-1', displayName: 'GPT Image', provider: 'OpenAI', type: 'IMAGE', isActive: true, apiKey: null, createdAt: new Date() },
    ];
  });

  test('GET /models omits apiKey and keeps apiKeySet + image capabilities', async () => {
    const res = await request(buildApp()).get('/api/admin/models');
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    const byId = Object.fromEntries(res.body.models.map((m) => [m.id, m]));
    assert.equal('apiKey' in byId.m1, false);
    assert.equal(byId.m1.apiKeySet, true);
    assert.equal(byId.m2.apiKeySet, false);
    assert.ok(byId.m2.capabilities, 'IMAGE rows still carry capabilities');
  });

  test('POST /models stores the key but never echoes it; empty key stores null', async () => {
    const res = await request(buildApp()).post('/api/admin/models')
      .send({ name: 'new-1', displayName: 'New', provider: 'OpenAI', type: 'TEXT', apiKey: SECRET });
    assert.equal(res.status, 201);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    assert.equal(res.body.model.apiKeySet, true);
    assert.equal(rows.find((r) => r.name === 'new-1').apiKey, SECRET);

    const blank = await request(buildApp()).post('/api/admin/models')
      .send({ name: 'new-2', displayName: 'New 2', provider: 'OpenAI', type: 'TEXT', apiKey: '' });
    assert.equal(blank.status, 201);
    assert.equal(rows.find((r) => r.name === 'new-2').apiKey, null);
    assert.equal(blank.body.model.apiKeySet, false);
  });

  test('PUT /models/:id: omitted or empty key keeps the stored one; null clears', async () => {
    const app = buildApp();
    const plain = await request(app).put('/api/admin/models/m1').send({ displayName: 'GPT X2' });
    assert.equal(plain.status, 200);
    assert.equal(JSON.stringify(plain.body).includes(SECRET), false);
    assert.equal(plain.body.model.apiKeySet, true);
    assert.equal(rows[0].apiKey, SECRET);

    const empty = await request(app).put('/api/admin/models/m1').send({ displayName: 'GPT X3', apiKey: '' });
    assert.equal(empty.status, 200);
    assert.equal(rows[0].apiKey, SECRET, 'an empty key must not wipe the stored one');

    const replaced = await request(app).put('/api/admin/models/m1').send({ apiKey: '  sk-rotated  ' });
    assert.equal(replaced.status, 200);
    assert.equal(rows[0].apiKey, 'sk-rotated');
    assert.equal(JSON.stringify(replaced.body).includes('sk-rotated'), false);

    const cleared = await request(app).put('/api/admin/models/m1').send({ apiKey: null });
    assert.equal(cleared.status, 200);
    assert.equal(rows[0].apiKey, null);
    assert.equal(cleared.body.model.apiKeySet, false);
  });

  test('PATCH /models/:id (Estado switch) never echoes the key', async () => {
    const res = await request(buildApp()).patch('/api/admin/models/m1').send({ isActive: false });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    assert.equal(res.body.model.apiKeySet, true);
    assert.equal(rows[0].apiKey, SECRET);
  });
});
