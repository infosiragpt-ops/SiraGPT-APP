const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

describe('api proxy route security', () => {
  let auth;
  let previousOpenAiKey;

  beforeEach(() => {
    auth = installAuthSessionMock();
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete require.cache[require.resolve('../src/routes/api')];
  });

  afterEach(() => {
    auth.restore();
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    delete require.cache[require.resolve('../src/routes/api')];
  });

  function buildApp() {
    return buildRouteTestApp('/api/proxy', reloadModule('../src/routes/api'));
  }

  test('requires authentication before proxying provider credentials', async () => {
    const res = await request(buildApp())
      .post('/api/proxy/chat/completions')
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
      });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('rejects oversized chat payloads before any provider call', async () => {
    const res = await request(buildApp())
      .post('/api/proxy/chat/completions')
      .set('Authorization', auth.authHeader)
      .send({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x'.repeat(20001) }],
      });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });

  test('rejects unbounded image fanout before any provider call', async () => {
    const res = await request(buildApp())
      .post('/api/proxy/images/generations')
      .set('Authorization', auth.authHeader)
      .send({
        model: 'gpt-image-1',
        prompt: 'chart',
        n: 99,
        size: '1024x1024',
      });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
  });
});
