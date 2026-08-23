const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const {
  applyUploadPreviewCors,
  createUploadMediaTokenHandler,
  createUploadStaticAccessGuard,
  createUploadR2Fallback,
  contentTypeForUploadPath,
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

describe('upload R2 fallback streams same-origin bytes', () => {
  let uploadDir;
  let auth;

  beforeEach(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-r2-uploads-'));
    auth = installAuthSessionMock({ id: 'user-a' });
    fs.mkdirSync(path.join(uploadDir, 'user-a'), { recursive: true });
  });

  afterEach(() => {
    auth.restore();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  function fakeStorage({
    enabled = true,
    objects = new Map(),
    contentType = 'application/pdf',
  } = {}) {
    const calls = { signedUrl: 0, readStream: 0 };
    return {
      calls,
      enabled: () => enabled,
      refFromKey: (key) => `r2:${key}`,
      exists: async (ref) => objects.has(ref),
      signedUrl: async () => {
        calls.signedUrl += 1;
        throw new Error('signedUrl must not be used for /uploads preview');
      },
      readStream: async (ref, { range } = {}) => {
        calls.readStream += 1;
        const buf = objects.get(ref);
        if (!buf) throw new Error('missing');
        let slice = buf;
        let contentRange;
        let contentLength = buf.length;
        if (range && String(range).startsWith('bytes=')) {
          const [startRaw, endRaw] = String(range).slice(6).split('-');
          const start = Number(startRaw);
          const end = endRaw === '' ? buf.length - 1 : Number(endRaw);
          slice = buf.subarray(start, end + 1);
          contentRange = `bytes ${start}-${start + slice.length - 1}/${buf.length}`;
          contentLength = slice.length;
        }
        return {
          stream: Readable.from(slice),
          contentLength,
          contentType,
          contentRange,
        };
      },
    };
  }

  function buildApp(storage, fallbackOpts = {}) {
    const app = express();
    app.use(cookieParser());
    const mount = (base) => {
      app.use(base, createUploadStaticAccessGuard({ uploadsDir: uploadDir, prisma }));
      app.use(base, express.static(uploadDir));
      app.use(base, createUploadR2Fallback({ objectStorage: storage, ...fallbackOpts }));
      app.use(base, (_req, res) => res.status(404).json({ error: 'File not found' }));
    };
    mount('/uploads');
    mount('/api/uploads');
    return app;
  }

  function getBinary(app, url, headers = {}) {
    const req = request(app).get(url).buffer(true).parse((incoming, cb) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  }

  test('infers PDF/DOCX types when R2 only stored octet-stream', () => {
    assert.equal(
      contentTypeForUploadPath('user-a/contrato.pdf', 'application/octet-stream'),
      'application/pdf',
    );
    assert.equal(
      contentTypeForUploadPath('user-a/Resumen.docx', 'application/octet-stream'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  test('streams an offloaded PDF without redirecting to a signed R2 URL', async () => {
    const bytes = Buffer.from('%PDF-1.4 streamed-preview');
    const storage = fakeStorage({
      objects: new Map([['r2:uploads/user-a/contrato.pdf', bytes]]),
    });
    const res = await getBinary(buildApp(storage), '/uploads/user-a/contrato.pdf', {
      Authorization: auth.authHeader,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['x-upload-source'], 'r2-stream');
    assert.equal(res.headers.location, undefined);
    assert.equal(Buffer.from(res.body).toString('utf8'), bytes.toString('utf8'));
    assert.equal(storage.calls.signedUrl, 0);
    assert.equal(storage.calls.readStream, 1);
  });

  test('streams an offloaded DOCX for the same chat preview path', async () => {
    const bytes = Buffer.from('PK docx-bytes');
    const storage = fakeStorage({
      objects: new Map([['r2:uploads/user-a/Resumen.docx', bytes]]),
      contentType: 'application/octet-stream',
    });
    const res = await getBinary(buildApp(storage), '/uploads/user-a/Resumen.docx', {
      Cookie: `token=${auth.token}`,
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /wordprocessingml\.document/);
    assert.equal(res.headers.location, undefined);
    assert.equal(Buffer.from(res.body).toString('utf8'), 'PK docx-bytes');
    assert.equal(storage.calls.signedUrl, 0);
  });

  test('honours byte-range so PDF.js can page-load offloaded files', async () => {
    const bytes = Buffer.from('0123456789abcdef');
    const storage = fakeStorage({
      objects: new Map([['r2:uploads/user-a/contrato.pdf', bytes]]),
    });
    const res = await getBinary(buildApp(storage), '/uploads/user-a/contrato.pdf', {
      Authorization: auth.authHeader,
      Range: 'bytes=0-3',
    });

    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 0-3/16');
    assert.equal(res.body.toString('utf8'), '0123');
    assert.equal(res.headers.location, undefined);
  });

  test('does not call signedUrl — source contract against the old 302', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/middleware/upload-static-access.js'),
      'utf8',
    );
    assert.doesNotMatch(source, /res\.redirect\(\s*302/);
    assert.match(source, /X-Upload-Source['"]\s*,\s*['"]r2-stream['"]/);
    assert.match(source, /pipeStreamToResponse/);
  });

  test('falls through when the object is not in R2', async () => {
    const storage = fakeStorage({ objects: new Map() });
    const res = await request(buildApp(storage))
      .get('/uploads/user-a/missing.pdf')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
    assert.equal(storage.calls.readStream, 0);
  });

  test('echoes credentialed CORS for an allowlisted chat origin', async () => {
    const bytes = Buffer.from('%PDF-1.4 cors-preview');
    const storage = fakeStorage({
      objects: new Map([['r2:uploads/user-a/contrato.pdf', bytes]]),
    });
    // Mirror CI: NODE_ENV=production + CORS_ORIGINS without localhost.
    const ciEnv = {
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://web.ci.example.test',
      FRONTEND_URL: 'https://web.ci.example.test',
    };
    const res = await getBinary(
      buildApp(storage, { env: ciEnv }),
      '/uploads/user-a/contrato.pdf',
      {
        Authorization: auth.authHeader,
        Origin: 'http://localhost:3000',
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(res.headers['access-control-allow-credentials'], 'true');
    assert.match(String(res.headers['access-control-expose-headers'] || ''), /Content-Type/);
    assert.equal(res.headers.location, undefined);
  });

  test('echoes localhost:3000 when CORS_ORIGINS is the CI production allowlist', () => {
    const sent = {};
    const res = {
      setHeader(name, value) { sent[name.toLowerCase()] = value; },
    };
    const applied = applyUploadPreviewCors(
      { headers: { origin: 'http://localhost:3000' } },
      res,
      {
        env: {
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://web.ci.example.test',
          FRONTEND_URL: 'https://web.ci.example.test',
        },
      },
    );
    assert.equal(applied, true);
    assert.equal(sent['access-control-allow-origin'], 'http://localhost:3000');
    assert.equal(sent['access-control-allow-credentials'], 'true');
  });

  test('echoes the configured production chat origin on streamed uploads', () => {
    const sent = {};
    const res = {
      setHeader(name, value) { sent[name.toLowerCase()] = value; },
    };
    const applied = applyUploadPreviewCors(
      { headers: { origin: 'https://siragpt.com' } },
      res,
      {
        env: {
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://siragpt.com,https://www.siragpt.com',
        },
      },
    );
    assert.equal(applied, true);
    assert.equal(sent['access-control-allow-origin'], 'https://siragpt.com');
    assert.equal(sent['access-control-allow-credentials'], 'true');
  });

  test('echoes FRONTEND_URL when it is the chat origin', () => {
    const sent = {};
    const res = {
      setHeader(name, value) { sent[name.toLowerCase()] = value; },
    };
    const applied = applyUploadPreviewCors(
      { headers: { origin: 'https://web.ci.example.test' } },
      res,
      {
        env: {
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://api.ci.example.test',
          FRONTEND_URL: 'https://web.ci.example.test',
        },
      },
    );
    assert.equal(applied, true);
    assert.equal(sent['access-control-allow-origin'], 'https://web.ci.example.test');
  });

  test('does not echo CORS for an origin outside the allowlist', () => {
    const sent = {};
    const res = {
      setHeader(name, value) { sent[name.toLowerCase()] = value; },
    };
    const applied = applyUploadPreviewCors(
      { headers: { origin: 'https://evil.example' } },
      res,
      { resolveOrigins: () => ['https://siragpt.com'] },
    );
    assert.equal(applied, false);
    assert.equal(sent['access-control-allow-origin'], undefined);
  });

  test('streams the live chip path shape via /api/uploads (authenticated proxy)', async () => {
    const userId = 'cmqcv09q10000qu01lxftg1r7';
    auth.restore();
    auth = installAuthSessionMock({ id: userId });
    fs.mkdirSync(path.join(uploadDir, userId), { recursive: true });
    const filename = 'files-1787459261443-51ade1ca8948.pdf';
    const bytes = Buffer.from('%PDF-1.4 live-chip');
    const storage = fakeStorage({
      objects: new Map([[`r2:uploads/${userId}/${filename}`, bytes]]),
    });
    const res = await getBinary(
      buildApp(storage),
      `/api/uploads/${userId}/${filename}`,
      { Authorization: auth.authHeader, Origin: 'https://siragpt.com' },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.headers['x-upload-source'], 'r2-stream');
    assert.equal(res.headers.location, undefined);
    assert.equal(Buffer.from(res.body).toString('utf8'), bytes.toString('utf8'));
  });

  test('still prefers a local file over the R2 stream', async () => {
    fs.writeFileSync(path.join(uploadDir, 'user-a', 'local.pdf'), 'local-disk-pdf');
    const storage = fakeStorage({
      objects: new Map([['r2:uploads/user-a/local.pdf', Buffer.from('r2-should-not-win')]]),
    });
    const res = await getBinary(buildApp(storage), '/uploads/user-a/local.pdf', {
      Authorization: auth.authHeader,
    });

    assert.equal(res.status, 200);
    assert.equal(Buffer.from(res.body).toString('utf8'), 'local-disk-pdf');
    assert.equal(storage.calls.readStream, 0);
  });
});
