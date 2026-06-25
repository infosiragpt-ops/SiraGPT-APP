'use strict';

// Unit tests for the Conocimientos v1 knowledge-file endpoints in
// backend/src/routes/gpts.js:
//   POST   /api/gpts/:id/knowledge
//   DELETE /api/gpts/:id/knowledge/:fileId
//   GET    /api/gpts/:id/knowledge
//
// No real DB / network / disk. We inject fakes for the router's four runtime
// dependencies (@prisma/client, middleware/auth, middleware/upload,
// services/fileProcessor) into require.cache BEFORE requiring the router, then
// drive it with supertest. This exercises the REAL route logic — ownership
// gating, File-record linking (customGptId), best-effort extraction, and the
// triple-scoped delete — against an in-memory store.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const ROUTER_PATH = path.join(ROUTES_DIR, 'gpts.js');

// ── Shared mutable test state (reset per server build) ──
let store; // { gpts: Map, files: Map }
let currentUserId; // who the auth middleware authenticates as
let extractionBehavior; // 'ok' | 'empty' | 'throw'
let gptFindManyCalls = []; // captured customGpt.findMany args (for soft-delete checks)

function resolveFrom(request_path) {
  // Resolve a dependency exactly as the router would (relative to its dir).
  return require.resolve(request_path, { paths: [ROUTES_DIR] });
}

function injectFakeModule(requestPath, exportsValue) {
  const resolved = resolveFrom(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

// ── Fake Prisma client ──
function buildFakePrisma() {
  let fileSeq = 0;
  let gptSeq = 0;
  const withCreator = (gpt) => ({ ...gpt, creator: { id: gpt.creatorId, name: 'Owner', avatar: null } });
  return {
    customGpt: {
      async findFirst({ where, include }) {
        for (const gpt of store.gpts.values()) {
          if (where.id && gpt.id !== where.id) continue;
          if (where.creatorId && gpt.creatorId !== where.creatorId) continue;
          const result = { ...gpt };
          if (include && include.knowledgeFiles) {
            result.knowledgeFiles = [...store.files.values()].filter(
              (f) => f.customGptId === gpt.id,
            );
          }
          return result;
        }
        return null;
      },
      async findMany(arg) {
        gptFindManyCalls.push(arg);
        return [];
      },
      async create({ data }) {
        const id = `gpt_new_${++gptSeq}`;
        const row = { id, ...data };
        store.gpts.set(id, row);
        return withCreator(row);
      },
      async findUnique({ where }) {
        const g = store.gpts.get(where.id);
        return g ? { ...g } : null;
      },
      async update({ where, data }) {
        const existing = store.gpts.get(where.id);
        if (!existing) throw new Error('not found');
        const updated = { ...existing, ...data };
        store.gpts.set(where.id, updated);
        return withCreator(updated);
      },
    },
    file: {
      async create({ data }) {
        const id = `file_${++fileSeq}`;
        const record = { id, createdAt: new Date(Date.now() + fileSeq), ...data };
        store.files.set(id, record);
        return { ...record };
      },
      async update({ where, data }) {
        const existing = store.files.get(where.id);
        if (!existing) throw new Error('not found');
        const updated = { ...existing, ...data };
        store.files.set(where.id, updated);
        return { ...updated };
      },
      async findMany({ where }) {
        let rows = [...store.files.values()];
        if (where) {
          if (where.customGptId) rows = rows.filter((f) => f.customGptId === where.customGptId);
          if (where.userId) rows = rows.filter((f) => f.userId === where.userId);
        }
        rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return rows.map((r) => ({ ...r }));
      },
      async findFirst({ where }) {
        for (const f of store.files.values()) {
          if (where.id && f.id !== where.id) continue;
          if (where.customGptId && f.customGptId !== where.customGptId) continue;
          if (where.userId && f.userId !== where.userId) continue;
          return { ...f };
        }
        return null;
      },
      async delete({ where }) {
        const existing = store.files.get(where.id);
        store.files.delete(where.id);
        return existing ? { ...existing } : null;
      },
    },
  };
}

function buildApp() {
  // Reset require cache for the router + injected deps so each build picks up
  // fresh fakes and the latest currentUserId / behavior.
  for (const p of [
    ROUTER_PATH,
    resolveFrom('@prisma/client'),
    resolveFrom('../middleware/auth'),
    resolveFrom('../middleware/upload'),
    resolveFrom('../services/fileProcessor'),
    resolveFrom('../services/upload-security-policy'),
  ]) {
    delete require.cache[p];
  }

  const fakePrisma = buildFakePrisma();

  // @prisma/client → PrismaClient constructor returns our fake.
  injectFakeModule('@prisma/client', { PrismaClient: function () { return fakePrisma; } });

  // auth → sets req.user from the test-controlled currentUserId.
  injectFakeModule('../middleware/auth', {
    authenticateToken: (req, _res, next) => {
      req.user = { id: currentUserId };
      next();
    },
  });

  // upload → a fake multer whose .array() reads req.body._files (array of
  // file descriptors) the test set, mirroring multer's req.files shape.
  const fakeUpload = {
    array: () => (req, _res, next) => {
      req.files = Array.isArray(req._injectedFiles) ? req._injectedFiles : [];
      next();
    },
    single: () => (req, _res, next) => next(),
  };
  injectFakeModule('../middleware/upload', fakeUpload);

  // fileProcessor → controllable extraction.
  injectFakeModule('../services/fileProcessor', {
    async processFile(file) {
      if (extractionBehavior === 'throw') throw new Error('extractor exploded');
      if (extractionBehavior === 'empty') return { success: false, extractedText: '' };
      return { success: true, extractedText: `EXTRACTED:${file.originalname}` };
    },
  });

  // upload-security-policy → permissive (real one is heavy; ownership/linking
  // logic is what we're testing). Echoes the declared mime.
  injectFakeModule('../services/upload-security-policy', {
    validateUploadPolicy: ({ declaredMime }) => ({ ok: true, mimeType: declaredMime }),
  });

  const router = require(ROUTER_PATH);

  const app = express();
  app.use(express.json());
  // Test-only middleware to thread injected files into req before the router.
  app.use((req, _res, next) => {
    if (req.headers['x-test-files']) {
      try { req._injectedFiles = JSON.parse(req.headers['x-test-files']); } catch { req._injectedFiles = []; }
    }
    next();
  });
  app.use('/api/gpts', router);
  return app;
}

function resetState() {
  store = { gpts: new Map(), files: new Map() };
  currentUserId = 'owner-1';
  extractionBehavior = 'ok';
  gptFindManyCalls = [];
}

function seedGpt(id, creatorId) {
  store.gpts.set(id, { id, creatorId, name: `GPT ${id}` });
}

function fileDescriptor(name, overrides = {}) {
  return {
    filename: `stored_${name}`,
    originalname: name,
    mimetype: 'text/plain',
    size: 1234,
    path: `/tmp/uploads/${name}`,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

test('POST /:id/knowledge rejects with 404 when the GPT is not owned by the caller', async () => {
  resetState();
  seedGpt('gpt-a', 'someone-else'); // owned by a different user
  currentUserId = 'owner-1';
  const app = buildApp();

  const res = await request(app)
    .post('/api/gpts/gpt-a/knowledge')
    .set('x-test-files', JSON.stringify([fileDescriptor('doc.txt')]))
    .send();

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'GPT not found');
  // No File row should have been created for a non-owned GPT.
  assert.equal(store.files.size, 0);
});

test('POST /:id/knowledge rejects with 404 for a non-existent GPT', async () => {
  resetState();
  const app = buildApp();

  const res = await request(app)
    .post('/api/gpts/missing/knowledge')
    .set('x-test-files', JSON.stringify([fileDescriptor('doc.txt')]))
    .send();

  assert.equal(res.status, 404);
  assert.equal(store.files.size, 0);
});

test('POST /:id/knowledge links uploaded files with customGptId and extracted text', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  const app = buildApp();

  const res = await request(app)
    .post('/api/gpts/gpt-a/knowledge')
    .set('x-test-files', JSON.stringify([fileDescriptor('a.txt'), fileDescriptor('b.txt')]))
    .send();

  assert.equal(res.status, 200);
  assert.equal(res.body.files.length, 2);

  // Every created File row is linked to the GPT and owned by the caller.
  const rows = [...store.files.values()];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.customGptId, 'gpt-a');
    assert.equal(row.userId, 'owner-1');
    assert.equal(row.extractedText, `EXTRACTED:${row.originalName}`);
  }

  // Response view exposes only safe fields, never path/userId.
  const view = res.body.files[0];
  assert.ok(view.id);
  assert.ok(view.originalName);
  assert.equal(typeof view.extractedChars, 'number');
  assert.equal(view.path, undefined);
  assert.equal(view.userId, undefined);
});

test('POST /:id/knowledge still links the file when extraction throws (null text)', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  extractionBehavior = 'throw';
  const app = buildApp();

  const res = await request(app)
    .post('/api/gpts/gpt-a/knowledge')
    .set('x-test-files', JSON.stringify([fileDescriptor('a.txt')]))
    .send();

  assert.equal(res.status, 200);
  assert.equal(res.body.files.length, 1);
  const row = [...store.files.values()][0];
  assert.equal(row.customGptId, 'gpt-a');
  assert.equal(row.extractedText, null); // extraction failure → null, upload still ok
});

test('POST /:id/knowledge returns 400 when no files are uploaded', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  const app = buildApp();

  const res = await request(app)
    .post('/api/gpts/gpt-a/knowledge')
    .set('x-test-files', JSON.stringify([]))
    .send();

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'No files uploaded');
});

test('GET /:id/knowledge lists files for the owner and 404s for non-owners', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  store.files.set('f1', { id: 'f1', userId: 'owner-1', customGptId: 'gpt-a', originalName: 'a.txt', size: 10, mimeType: 'text/plain', extractedText: 'hello', createdAt: new Date() });

  let app = buildApp();
  let res = await request(app).get('/api/gpts/gpt-a/knowledge').send();
  assert.equal(res.status, 200);
  assert.equal(res.body.files.length, 1);
  assert.equal(res.body.files[0].extractedChars, 5);

  // Different user → 404.
  currentUserId = 'intruder';
  app = buildApp();
  res = await request(app).get('/api/gpts/gpt-a/knowledge').send();
  assert.equal(res.status, 404);
});

test('DELETE /:id/knowledge/:fileId removes an owned file', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  store.files.set('f1', { id: 'f1', userId: 'owner-1', customGptId: 'gpt-a', originalName: 'a.txt', size: 10, mimeType: 'text/plain', path: '/tmp/a', createdAt: new Date() });
  const app = buildApp();

  const res = await request(app).delete('/api/gpts/gpt-a/knowledge/f1').send();
  assert.equal(res.status, 200);
  assert.equal(res.body.fileId, 'f1');
  assert.equal(store.files.has('f1'), false);
});

test('DELETE /:id/knowledge/:fileId 404s when the GPT is not owned', async () => {
  resetState();
  seedGpt('gpt-a', 'someone-else');
  store.files.set('f1', { id: 'f1', userId: 'someone-else', customGptId: 'gpt-a', originalName: 'a.txt', size: 10, mimeType: 'text/plain', path: '/tmp/a', createdAt: new Date() });
  currentUserId = 'owner-1';
  const app = buildApp();

  const res = await request(app).delete('/api/gpts/gpt-a/knowledge/f1').send();
  assert.equal(res.status, 404);
  // File untouched.
  assert.equal(store.files.has('f1'), true);
});

test('DELETE /:id/knowledge/:fileId 404s for a file belonging to a different GPT', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  seedGpt('gpt-b', 'owner-1');
  // File belongs to gpt-b, but we try to delete it via gpt-a.
  store.files.set('f1', { id: 'f1', userId: 'owner-1', customGptId: 'gpt-b', originalName: 'a.txt', size: 10, mimeType: 'text/plain', path: '/tmp/a', createdAt: new Date() });
  const app = buildApp();

  const res = await request(app).delete('/api/gpts/gpt-a/knowledge/f1').send();
  assert.equal(res.status, 404);
  assert.equal(store.files.has('f1'), true);
});

test('POST / rejects out-of-range temperature / invalid maxTokens (400 before create)', async () => {
  resetState();
  const app = buildApp();
  const bad = [
    [JSON.stringify({ name: 'A', instructions: 'do', temperature: 5 }), /temperature/],
    [JSON.stringify({ name: 'A', instructions: 'do', temperature: -0.5 }), /temperature/],
    [JSON.stringify({ name: 'A', instructions: 'do', temperature: 'hot' }), /temperature/],
    [JSON.stringify({ name: 'A', instructions: 'do', maxTokens: 0 }), /maxTokens/],
    [JSON.stringify({ name: 'A', instructions: 'do', maxTokens: -3 }), /maxTokens/],
    [JSON.stringify({ name: 'A', instructions: 'do', maxTokens: 1.5 }), /maxTokens/],
  ];
  for (const [gpts, m] of bad) {
    const res = await request(app).post('/api/gpts').send({ gpts });
    assert.equal(res.status, 400, `expected 400 for ${gpts}`);
    assert.match(res.body.error, m);
  }
  assert.equal(store.gpts.size, 0, 'no GPT row created for any rejected request');
});

test('POST / accepts boundary-valid temperature/maxTokens and creates the GPT', async () => {
  resetState();
  const app = buildApp();
  const res = await request(app).post('/api/gpts').send({
    gpts: JSON.stringify({ name: 'Good', instructions: 'be helpful', temperature: 2, maxTokens: 100 }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.gpt.name, 'Good');
  assert.equal(store.gpts.size, 1);
});

test('PUT /:id rejects out-of-range temperature (400 before the ownership lookup)', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  const app = buildApp();
  const res = await request(app).put('/api/gpts/gpt-a').send({ gpts: JSON.stringify({ temperature: 9 }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /temperature/);
});

test('PUT /:id accepts a valid temperature/maxTokens update for an owned GPT', async () => {
  resetState();
  seedGpt('gpt-a', 'owner-1');
  const app = buildApp();
  const res = await request(app).put('/api/gpts/gpt-a').send({ gpts: JSON.stringify({ temperature: 1.2, maxTokens: 50 }) });
  assert.equal(res.status, 200);
  assert.equal(store.gpts.get('gpt-a').temperature, 1.2);
  assert.equal(store.gpts.get('gpt-a').maxTokens, 50);
});

test('GET / excludes soft-deleted GPTs (deletedAt:null in the where)', async () => {
  resetState();
  const app = buildApp();
  await request(app).get('/api/gpts').send();
  assert.ok(gptFindManyCalls.length >= 1, 'list endpoint queried customGpt.findMany');
  assert.ok(
    JSON.stringify(gptFindManyCalls).includes('"deletedAt":null'),
    'the list where-clause must constrain deletedAt:null so tombstoned GPTs never leak',
  );
});

test('GET /categories excludes soft-deleted GPTs', async () => {
  resetState();
  const app = buildApp();
  await request(app).get('/api/gpts/categories').send();
  const catCall = gptFindManyCalls.find((c) => c && c.distinct);
  assert.ok(catCall, 'categories endpoint queried customGpt.findMany with distinct');
  assert.equal(catCall.where.deletedAt, null, 'categories where filters out soft-deleted rows');
});
