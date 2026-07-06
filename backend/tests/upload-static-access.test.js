const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const {
  createUploadStaticAccessGuard,
  normaliseUploadPath,
  classifyUploadPath,
} = require('../src/middleware/upload-static-access');
const { installAuthSessionMock } = require('./http-test-utils');
const prisma = require('../src/config/database');

describe('static upload access guard', () => {
  let uploadDir;
  let auth;

  beforeEach(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-static-uploads-'));
    auth = installAuthSessionMock({ id: 'user-a' });

    fs.mkdirSync(path.join(uploadDir, 'user-a'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'user-b'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'documents', 'user-a'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'documents', 'user-b'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'gpt-icons'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(uploadDir, 'screenshots', 'session-1'), { recursive: true });

    fs.writeFileSync(path.join(uploadDir, 'user-a', 'private.txt'), 'private user a');
    fs.writeFileSync(path.join(uploadDir, 'user-b', 'private.txt'), 'private user b');
    fs.writeFileSync(path.join(uploadDir, 'documents', 'user-a', 'report.txt'), 'document user a');
    fs.writeFileSync(path.join(uploadDir, 'documents', 'user-b', 'report.txt'), 'document user b');
    fs.writeFileSync(path.join(uploadDir, 'gpt-icons', 'assistant.png'), 'public gpt icon');
    fs.writeFileSync(path.join(uploadDir, 'images', 'public.txt'), 'public image asset');
    fs.writeFileSync(path.join(uploadDir, 'screenshots', 'session-1', 'shot.png'), 'internal screenshot');
  });

  afterEach(() => {
    auth.restore();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  function buildApp() {
    const app = express();
    app.use(cookieParser());
    app.use('/uploads', createUploadStaticAccessGuard({ uploadsDir: uploadDir, prisma }));
    app.use('/uploads', express.static(uploadDir));
    return app;
  }

  test('classifies public, owned, and blocked upload paths', () => {
    assert.equal(normaliseUploadPath('/user-a/private.txt'), 'user-a/private.txt');
    assert.equal(normaliseUploadPath('/%2e%2e/private.txt'), null);
    assert.deepEqual(classifyUploadPath('gpt-icons/assistant.png'), { kind: 'public' });
    assert.deepEqual(classifyUploadPath('images/generated.png'), { kind: 'public' });
    assert.deepEqual(classifyUploadPath('documents/user-a/report.txt'), { kind: 'owned', userId: 'user-a' });
    assert.deepEqual(classifyUploadPath('screenshots/session-1/shot.png'), { kind: 'blocked' });
    // GPT avatars (icon-<ts>-<hash>.<ext>) are public — shown in the GPT store.
    assert.deepEqual(classifyUploadPath('user-a/icon-1783372450408-bf21d362bb8d.png'), { kind: 'public' });
    assert.deepEqual(classifyUploadPath('user-a/icon-1-abcdef123456.webp'), { kind: 'public' });
    // A non-icon file under the same dir stays owned; a sub-nested icon too.
    assert.deepEqual(classifyUploadPath('user-a/secret.pdf'), { kind: 'owned', userId: 'user-a' });
    assert.deepEqual(classifyUploadPath('user-a/sub/icon-1-abcdef123456.png'), { kind: 'owned', userId: 'user-a' });
  });

  test('requires authentication for user-scoped uploads', async () => {
    const res = await request(buildApp()).get('/uploads/user-a/private.txt');

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Authentication required');
  });

  test('serves a user-scoped upload only to the owning user', async () => {
    const res = await request(buildApp())
      .get('/uploads/user-a/private.txt')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.text, 'private user a');
  });

  test('accepts the httpOnly session cookie for direct image/document tags', async () => {
    const res = await request(buildApp())
      .get('/uploads/user-a/private.txt')
      .set('Cookie', [`token=${auth.token}`]);

    assert.equal(res.status, 200);
    assert.equal(res.text, 'private user a');
  });

  test('does not serve another user upload to the authenticated user', async () => {
    const res = await request(buildApp())
      .get('/uploads/user-b/private.txt')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Forbidden');
  });

  test('protects generated document folders by owner', async () => {
    const owned = await request(buildApp())
      .get('/uploads/documents/user-a/report.txt')
      .set('Authorization', auth.authHeader);
    const other = await request(buildApp())
      .get('/uploads/documents/user-b/report.txt')
      .set('Authorization', auth.authHeader);

    assert.equal(owned.status, 200);
    assert.equal(owned.text, 'document user a');
    assert.equal(other.status, 403);
  });

  test('leaves explicitly public media folders compatible with existing previews', async () => {
    const res = await request(buildApp()).get('/uploads/images/public.txt');

    assert.equal(res.status, 200);
    assert.equal(res.text, 'public image asset');
  });

  test('serves GPT icons publicly for store listings', async () => {
    const res = await request(buildApp()).get('/uploads/gpt-icons/assistant.png');

    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), 'public gpt icon');
  });

  test('does not expose internal upload working directories through static hosting', async () => {
    const res = await request(buildApp())
      .get('/uploads/screenshots/session-1/shot.png')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'File not found');
  });
});
