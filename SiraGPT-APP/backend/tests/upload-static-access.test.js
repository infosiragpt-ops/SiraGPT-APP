const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  createUploadMediaTokenHandler,
  createUploadStaticAccessGuard,
  normaliseUploadPath,
  classifyUploadPath,
  mintUploadMediaToken,
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

  test('rejects a normal session JWT supplied in the upload query string', async () => {
    const res = await request(buildApp())
      .get(`/uploads/user-a/private.txt?token=${encodeURIComponent(auth.token)}`);

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Authentication required');
  });

  test('accepts a short-lived audience, path, and user-scoped media token in the query', async () => {
    assert.equal(typeof mintUploadMediaToken, 'function');
    const mediaToken = mintUploadMediaToken({
      userId: 'user-a',
      uploadPath: '/uploads/user-a/private.txt',
      jwtSecret: process.env.JWT_SECRET,
    });

    const res = await request(buildApp())
      .get(`/uploads/user-a/private.txt?token=${encodeURIComponent(mediaToken)}`);

    assert.equal(res.status, 200);
    assert.equal(res.text, 'private user a');
  });

  test('media token minting clamps lifetime and assigns an unpredictable JWT id', () => {
    assert.equal(typeof mintUploadMediaToken, 'function');
    const first = mintUploadMediaToken({
      userId: 'user-a',
      uploadPath: '/uploads/user-a/private.txt',
      jwtSecret: process.env.JWT_SECRET,
      ttlSeconds: 86_400,
    });
    const second = mintUploadMediaToken({
      userId: 'user-a',
      uploadPath: '/uploads/user-a/private.txt',
      jwtSecret: process.env.JWT_SECRET,
      ttlSeconds: 86_400,
    });
    const firstClaims = jwt.decode(first);
    const secondClaims = jwt.decode(second);

    assert.equal(firstClaims.aud, 'siragpt-upload-static');
    assert.equal(firstClaims.sub, 'user-a');
    assert.equal(firstClaims.path, 'user-a/private.txt');
    assert.ok(firstClaims.exp - firstClaims.iat <= 300);
    assert.match(firstClaims.jti, /^[0-9a-f-]{36}$/i);
    assert.notEqual(firstClaims.jti, secondClaims.jti);
  });

  test('authenticated media-token handler mints only for the calling user path', () => {
    assert.equal(typeof createUploadMediaTokenHandler, 'function');
    const sent = [];
    const handler = createUploadMediaTokenHandler({
      jwtSecret: process.env.JWT_SECRET,
    });
    const req = {
      user: { id: 'user-a' },
      body: { path: '/uploads/user-a/private.txt' },
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        sent.push(body);
        return body;
      },
    };

    handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /^\/uploads\/user-a\/private\.txt\?token=/);
    const claims = jwt.verify(sent[0].token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      audience: 'siragpt-upload-static',
      issuer: 'siragpt-api',
    });
    assert.equal(claims.sub, 'user-a');
    assert.equal(claims.path, 'user-a/private.txt');
  });

  test('files API exposes media token minting only behind session authentication', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/routes/files.js'),
      'utf8',
    );
    assert.match(
      source,
      /router\.post\(\s*['"]\/media-token['"]\s*,\s*authenticateToken\s*,/,
    );
  });

  test('backend clients never append a session JWT to upload URLs', () => {
    const scriptsDir = path.resolve(__dirname, '../scripts');
    const offenders = fs.readdirSync(scriptsDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => {
        const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
        return /\$\{(?:artifacts?\[0\]|art)\.url\}\?token=\$\{encodeURIComponent\(token\)\}/.test(source);
      });
    assert.deepEqual(offenders, []);
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
