const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const {
  buildRouteTestApp,
  createContractValidator,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

const assertContractResponse = createContractValidator();

describe('HTTP file upload route', () => {
  let auth;
  let uploadDir;
  let previousUploadDir;
  let previousOpenAiKey;

  beforeEach(() => {
    auth = installAuthSessionMock();
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-upload-http-'));
    previousUploadDir = process.env.UPLOAD_DIR;
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.UPLOAD_DIR = uploadDir;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/middleware/upload')];
    delete require.cache[require.resolve('../src/routes/files')];
    if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousUploadDir;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    fs.rmSync(uploadDir, { recursive: true, force: true });
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/files', reloadModule('../src/routes/files'));
  }

  test('requires auth before multipart upload handling', async () => {
    const res = await request(buildApp())
      .post('/api/files/upload')
      .attach('files', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('returns a 400 contract response when no files are attached', async () => {
    const res = await request(buildApp())
      .post('/api/files/upload')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'No files uploaded');
    assertContractResponse('files.upload', 400, res.body);
  });

  test('rejects disallowed file types before persistence or extraction', async () => {
    const res = await request(buildApp())
      .post('/api/files/upload')
      .set('Authorization', auth.authHeader)
      .attach('files', Buffer.from('MZ fake binary'), {
        filename: 'payload.exe',
        contentType: 'application/x-msdownload',
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Tipo no permitido/i);
    assert.equal(fs.readdirSync(uploadDir).length, 0);
    assertContractResponse('files.upload', 400, res.body);
  });
});
