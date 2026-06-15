'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Stub auth BEFORE the codex router loads it.
const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) {
    req.user = { id: 'u-1' };
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
    startDev: async (project) => { runnerCalls.push(['startDev', project]); return { ok: true, port: 5173, project }; },
    devStatus: async () => ({ running: true, ready: true, project: 'p1' }),
    stopDev: async () => ({ ok: true }),
    exportWorkspace: async (project) => { runnerCalls.push(['exportWorkspace', project]); return { ok: true, project, files: 5 }; },
  }),
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: (id) => `.codex-workspaces/${id}`,
  RunnerError: class RunnerError extends Error {},
});

const codexRoutes = require('../src/routes/codex');

after(() => { restoreAuth(); restoreService(); restoreRunner(); delete process.env.CODEX_AGENT_V2; });
beforeEach(() => { process.env.CODEX_AGENT_V2 = '1'; });

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
  assert.equal(res.body.devUrl, 'http://localhost:5173');
  assert.deepEqual(runnerCalls.at(-1), ['startDev', 'p1']);
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
