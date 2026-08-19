const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  buildRouteTestApp,
  createContractValidator,
} = require('./http-test-utils');
const { createGithubCodexRouter } = require('../src/routes/github-codex');

const assertContractResponse = createContractValidator();
const AUTH_HEADER = 'Bearer http-codex-token';
const TEST_USER = { id: 'http-codex-user', email: 'http-codex@example.com', isAdmin: false };

describe('HTTP GitHub Codex routes', () => {
  function buildApp({ repoHandler } = {}) {
    const calls = { context: 0, files: 0, retrieve: 0 };
    const authenticate = (req, res, next) => {
      if (req.headers.authorization !== AUTH_HEADER) {
        res.status(401).json({ error: 'Access token required' });
        return;
      }
      req.user = TEST_USER;
      next();
    };

    const router = createGithubCodexRouter({
      authenticate,
      codeFilesForRag: (files) => files.map((file) => ({ filename: file.path, content: file.content })),
      githubRagCollection: ({ repository, branch }) => `github:${repository}:${branch || 'default'}`,
      createConnector: () => ({
        getStatus: () => ({
          configured: true,
          tokenConfigured: true,
          mode: 'server-side',
          retry: { limit: 2 },
          throttle: { maxRetries: 2, retryAfterSeconds: 60 },
        }),
        getRepositoryContext: async (args) => {
          calls.context += 1;
          if (repoHandler) return repoHandler(args);
          return {
            repository: args.repository,
            branch: args.branch || 'main',
            pullRequests: [],
            issues: [],
            actions: { status: 'warning', reason: 'actions unavailable' },
            readme: null,
          };
        },
        getRepositoryFiles: async (args) => {
          calls.files += 1;
          return {
            repository: args.repository,
            branch: args.branch || 'main',
            collection: `github:${args.repository}:main`,
            files: [{ path: 'README.md', content: '# test', bytes: 6 }],
            skipped: [],
            limits: { limit: Number(args.limit || 20), maxBytes: Number(args.maxBytes || 120000) },
          };
        },
      }),
      normalizeError: (error) => ({
        status: error.status || 500,
        body: {
          error: error.code || 'github_request_failed',
          code: error.code || 'github_request_failed',
          headers: {
            retryAfter: error.headers?.['retry-after'] || null,
            rateLimitRemaining: error.headers?.['x-ratelimit-remaining'] || null,
          },
        },
      }),
      ragService: {
        ingestCode: async () => ({ chunks: 1 }),
        retrieve: async (_userId, collection, query, k) => {
          calls.retrieve += 1;
          return [{ text: `hit:${query}`, collection, score: 0.9, k }];
        },
      },
    });

    return { app: buildRouteTestApp('/api/codex/github', router), calls };
  }

  test('requires bearer auth before reading status', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/codex/github/status');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('returns sanitized status through the route contract', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/codex/github/status')
      .set('Authorization', AUTH_HEADER);

    assert.equal(res.status, 200);
    assert.equal(res.body.github.tokenConfigured, true);
    assert.equal(JSON.stringify(res.body).includes('ghp_'), false);
    assertContractResponse('github.codex.status', 200, res.body);
  });

  test('rejects invalid repository query before connector calls', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .get('/api/codex/github/repo')
      .query({ repo: 'SiraGPT-ORg/siraGPT', limit: 99 })
      .set('Authorization', AUTH_HEADER);

    assert.equal(res.status, 400);
    assert.equal(calls.context, 0);
    assertContractResponse('github.codex.repo', 400, res.body);
  });

  test('maps repository context responses through the HTTP contract', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .get('/api/codex/github/repo')
      .query({ repo: 'SiraGPT-ORg/siraGPT', branch: 'main', limit: 3 })
      .set('Authorization', AUTH_HEADER);

    assert.equal(res.status, 200);
    assert.equal(calls.context, 1);
    assert.equal(res.body.context.repository, 'SiraGPT-ORg/siraGPT');
    assertContractResponse('github.codex.repo', 200, res.body);
  });

  test('normalizes rate limit errors with sanitized retry metadata', async () => {
    const { app } = buildApp({
      repoHandler: async () => {
        const error = new Error('token ghp_secret should not leak');
        error.status = 429;
        error.code = 'github_rate_limited';
        error.headers = { 'retry-after': '30', 'x-ratelimit-remaining': '0', authorization: 'Bearer ghp_secret' };
        throw error;
      },
    });

    const res = await request(app)
      .get('/api/codex/github/repo')
      .query({ repo: 'SiraGPT-ORg/siraGPT' })
      .set('Authorization', AUTH_HEADER);

    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'github_rate_limited');
    assert.equal(res.body.headers.retryAfter, '30');
    assert.equal(JSON.stringify(res.body).includes('ghp_secret'), false);
    assertContractResponse('github.codex.repo', 429, res.body);
  });

  test('retrieves GitHub RAG snippets without cloning repositories', async () => {
    const { app, calls } = buildApp();
    const res = await request(app)
      .post('/api/codex/github/retrieve')
      .set('Authorization', AUTH_HEADER)
      .send({ repo: 'SiraGPT-ORg/siraGPT', query: 'where is auth middleware?', k: 2 });

    assert.equal(res.status, 200);
    assert.equal(calls.retrieve, 1);
    assert.equal(res.body.ok, true);
    assert.match(res.body.collection, /^github:SiraGPT-ORg\/siraGPT:/);
    assertContractResponse('github.codex.retrieve', 200, res.body);
  });
});
