const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  installAuthSessionMock,
  mockResolvedModule,
  reloadModule,
} = require('./http-test-utils');

describe('api proxy route security', () => {
  let auth;
  let previousOpenAiKey;
  let restoreImageEngineMock;

  beforeEach(() => {
    auth = installAuthSessionMock();
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete require.cache[require.resolve('../src/routes/api')];
  });

  afterEach(() => {
    auth.restore();
    restoreImageEngineMock?.();
    restoreImageEngineMock = undefined;
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

  test('legacy image generations use provider failover engine and keep OpenAI-compatible response', async () => {
    let capturedSpec = null;
    restoreImageEngineMock = mockResolvedModule(
      require.resolve('../src/services/media/image-engine'),
      {
        generateImage: async (spec) => {
          capturedSpec = spec;
          return {
            ok: true,
            provider: 'openai',
            model: 'gpt-image-2',
            images: [{ b64: 'IMAGE_B64' }],
          };
        },
      },
    );

    const res = await request(buildApp())
      .post('/api/proxy/images/generations')
      .set('Authorization', auth.authHeader)
      .send({
        model: 'gpt-4o',
        prompt: 'chart',
        n: 1,
        size: '1792x1024',
      });

    assert.equal(res.status, 200);
    assert.equal(capturedSpec.model, 'gpt-4o');
    assert.equal(capturedSpec.aspectRatio, '16:9');
    assert.equal(capturedSpec.failover, true);
    assert.deepEqual(res.body.data, [{ b64_json: 'IMAGE_B64' }]);
    assert.equal(res.body.model, 'gpt-image-2');
  });
});
