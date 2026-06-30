'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Stub auth BEFORE the codex router loads it.
const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) {
    req.user = { id: 'u-1', isAdmin: true, isSuperAdmin: false };
    next();
  },
});

// Stub project-service + runner-client BEFORE the router loads them.
const serviceCalls = [];
const servicePath = require.resolve('../src/services/codex/project-service');
const restoreService = mockResolvedModule(servicePath, {
  createProject: async (args) => {
    serviceCalls.push(['createProject', args]);
    return { id: 'p1', name: args.name, status: 'ready', workspacePath: 'projects/p1', previewUrl: 'http://localhost:5173', error: null };
  },
  listProjects: async (args) => {
    serviceCalls.push(['listProjects', args]);
    return [{ id: 'p1', name: 'A', status: 'ready' }];
  },
  getProject: async (args) => {
    serviceCalls.push(['getProject', args]);
    return args.id === 'p1' ? { id: 'p1', name: 'A', status: 'ready' } : null;
  },
});

const runnerCalls = [];
const runnerPath = require.resolve('../src/services/codex/runner-client');
const restoreRunner = mockResolvedModule(runnerPath, {
  createRunnerClient: () => ({
    startDev: async (project, opts) => { runnerCalls.push(['startDev', project, opts]); return { ok: true, port: 5173, project }; },
    devStatus: async () => ({ running: true, ready: true, project: 'p1' }),
    stopDev: async () => ({ ok: true }),
    exportWorkspace: async (project) => { runnerCalls.push(['exportWorkspace', project]); return { ok: true, project, files: 5 }; },
    exec: async (project, cmd) => { runnerCalls.push(['exec', project, cmd]); return { ok: true, exitCode: 0, stdout: 'src/main.tsx\nindex.html\npackage.json\n', stderr: '' }; },
    readFile: async (project, path) => { runnerCalls.push(['readFile', project, path]); return { ok: true, path, content: '<html></html>' }; },
  }),
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: (id) => `.codex-workspaces/${id}`,
  RunnerError: class RunnerError extends Error {},
});

const codexRoutes = require('../src/routes/codex');

after(() => { restoreAuth(); restoreService(); restoreRunner(); delete process.env.CODEX_AGENT_V2; delete process.env.CODEX_AGENT_ALLOWED_USER_IDS; });
beforeEach(() => {
  process.env.CODEX_AGENT_V2 = '1';
  delete process.env.CODEX_AGENT_ALLOWED_USER_IDS;
  serviceCalls.length = 0;
  runnerCalls.length = 0;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/codex', codexRoutes);
  return app;
}

test('GET /health responds 200 with enabled=false when the flag is off', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).get('/api/codex/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, enabled: false });
});

test('GET /access reports flag and user execution access', async () => {
  const res = await request(buildApp()).get('/api/codex/access');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.canRun, true);
});

test('flag off ⇒ every other route is 404 not_found', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).post('/api/codex/projects').send({ name: 'X' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('POST /projects validates name and forwards userId to the service', async () => {
  const bad = await request(buildApp()).post('/api/codex/projects').send({});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_failed');

  const res = await request(buildApp()).post('/api/codex/projects').send({ name: '  Tienda  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.project.id, 'p1');
  const call = serviceCalls.find((c) => c[0] === 'createProject');
  assert.equal(call[1].userId, 'u-1');
  assert.equal(call[1].name, 'Tienda');
});

test('GET /projects lists own projects; GET /projects/:id 404s for foreign ids', async () => {
  const list = await request(buildApp()).get('/api/codex/projects');
  assert.equal(list.status, 200);
  assert.equal(list.body.projects.length, 1);

  const found = await request(buildApp()).get('/api/codex/projects/p1');
  assert.equal(found.status, 200);
  const missing = await request(buildApp()).get('/api/codex/projects/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'project_not_found');
});

test('POST /projects/:id/preview/start proxies the runner and adds devUrl', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
  assert.equal(res.status, 200);
  assert.match(res.body.devUrl, /^\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
  assert.equal(runnerCalls.at(-1)[0], 'startDev');
  assert.equal(runnerCalls.at(-1)[1], 'p1');
  assert.match(runnerCalls.at(-1)[2].basePath, /^\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
});

test('tokenized preview proxy strips credentials and forces frame headers', async () => {
  const upstreamHits = [];
  const server = http.createServer((req, res) => {
    upstreamHits.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.setHeader('Set-Cookie', 'preview=unsafe');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(`ok:${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.CODE_RUNNER_DEV_INTERNAL_URL = `http://127.0.0.1:${port}`;
  try {
    const start = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
    assert.equal(start.status, 200);
    const res = await request(buildApp())
      .get(start.body.previewUrl)
      .set('Cookie', 'sid=secret')
      .set('Authorization', 'Bearer secret');
    assert.equal(res.status, 200);
    assert.match(res.text, /^ok:\/api\/codex\/projects\/p1\/preview\/.+\/app\/$/);
    assert.equal(upstreamHits[0].cookie, undefined);
    assert.equal(upstreamHits[0].authorization, undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'self'");
  } finally {
    delete process.env.CODE_RUNNER_DEV_INTERNAL_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('preview routes 404 on foreign project ids (ownership gate)', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/nope/preview/start');
  assert.equal(res.status, 404);
});

test('POST /projects/:id/export mirrors via the runner and returns hostPath', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/p1/export');
  assert.equal(res.status, 200);
  assert.equal(res.body.files, 5);
  assert.equal(res.body.hostPath, '.codex-workspaces/p1');
  assert.deepEqual(runnerCalls.at(-1), ['exportWorkspace', 'p1']);
});

test('export route 404s on foreign project ids (ownership gate)', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/nope/export');
  assert.equal(res.status, 404);
});

test('GET /projects/:id/files lists source files (sorted) via the runner', async () => {
  const res = await request(buildApp()).get('/api/codex/projects/p1/files');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.files, ['index.html', 'package.json', 'src/main.tsx']);
  assert.deepEqual(runnerCalls.at(-1), ['exec', 'p1', ['git', 'ls-files', '-co', '--exclude-standard']]);
});

test('GET /projects/:id/file reads a file via the runner; requires ?path', async () => {
  const missing = await request(buildApp()).get('/api/codex/projects/p1/file');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'path_required');

  const res = await request(buildApp()).get('/api/codex/projects/p1/file?path=index.html');
  assert.equal(res.status, 200);
  assert.equal(res.body.content, '<html></html>');
  assert.deepEqual(runnerCalls.at(-1), ['readFile', 'p1', 'index.html']);
});

test('files/file routes 404 on foreign project ids (ownership gate)', async () => {
  assert.equal((await request(buildApp()).get('/api/codex/projects/nope/files')).status, 404);
  assert.equal((await request(buildApp()).get('/api/codex/projects/nope/file?path=x')).status, 404);
});
