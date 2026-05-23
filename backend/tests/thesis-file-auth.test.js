const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('Thesis file delivery auth boundaries', () => {
  let auth;
  let originalOpenAiKey;
  let route;
  const documentsRoot = path.join(__dirname, '../uploads/documents');

  beforeEach(async () => {
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    auth = installAuthSessionMock({ id: 'thesis-user-a' });
    route = reloadModule('../src/routes/thesis');
    await fs.mkdir(path.join(documentsRoot, 'thesis-user-a'), { recursive: true });
    await fs.mkdir(path.join(documentsRoot, 'thesis-user-b'), { recursive: true });
    await fs.writeFile(path.join(documentsRoot, 'thesis-user-a', 'Thesis_private.docx'), 'owned by user a');
    await fs.writeFile(path.join(documentsRoot, 'thesis-user-b', 'Thesis_private.docx'), 'owned by user b');
  });

  afterEach(async () => {
    auth.restore();
    await fs.rm(path.join(documentsRoot, 'thesis-user-a'), { recursive: true, force: true });
    await fs.rm(path.join(documentsRoot, 'thesis-user-b'), { recursive: true, force: true });
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  function buildApp() {
    return buildRouteTestApp('/api/thesis', route);
  }

  test('serves only the authenticated user document directory', async () => {
    const res = await request(buildApp())
      .get('/api/thesis/files/Thesis_private.docx')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.text, 'owned by user a');
  });

  test('does not search other users directories when the caller has no matching file', async () => {
    await fs.rm(path.join(documentsRoot, 'thesis-user-a', 'Thesis_private.docx'));

    const res = await request(buildApp())
      .get('/api/thesis/files/Thesis_private.docx')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 404);
  });

  test('rejects traversal-style filenames', async () => {
    const res = await request(buildApp())
      .get('/api/thesis/files/%2e%2e%2f%2e%2e%2f.env')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 400);
  });
});
