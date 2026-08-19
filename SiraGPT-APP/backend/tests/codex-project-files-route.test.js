'use strict';

// POST /api/codex/projects/:id/files — workspace import (browser → Codex
// project). Contract tests with the real router + fake services injected via
// require.cache (same offline pattern as codex-route-contract.test.js /
// codex-run-route.test.js).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Auth stub: 401 without a bearer; the x-test-user header selects the persona
// (u-1 admin owner / u-2 admin non-owner / u-3 plain user without access).
const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, res, next) {
    if (!req.headers.authorization) return res.status(401).json({ error: 'unauthenticated' });
    const who = String(req.headers['x-test-user'] || 'u-1');
    req.user = { id: who, isAdmin: who !== 'u-3', isSuperAdmin: false };
    return next();
  },
});

// u-1 owns p1 (idle) and p-busy (active run). Everything else → not found.
const serviceCalls = [];
const restoreProjectService = mockResolvedModule(require.resolve('../src/services/codex/project-service'), {
  createProject: async () => ({}),
  listProjects: async () => [],
  getProject: async (args) => {
    serviceCalls.push(['getProject', args]);
    if (args.userId !== 'u-1') return null;
    if (args.id === 'p1') return { id: 'p1', name: 'A', status: 'ready' };
    if (args.id === 'p-busy') return { id: 'p-busy', name: 'B', status: 'ready' };
    return null;
  },
});

class RunServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const restoreRunService = mockResolvedModule(require.resolve('../src/services/codex/run-service'), {
  RunServiceError,
  createRun: async () => ({}),
  cancelRun: async () => ({}),
  getRun: async () => null,
  listRuns: async () => [],
  hasActiveRun: async ({ projectId }) => {
    serviceCalls.push(['hasActiveRun', projectId]);
    return projectId === 'p-busy';
  },
});

const runnerCalls = [];
let writeFilesImpl = async (project, files) => {
  runnerCalls.push(['writeFiles', project, files]);
  return { ok: true, written: files.length };
};
const restoreRunner = mockResolvedModule(require.resolve('../src/services/codex/runner-client'), {
  createRunnerClient: () => ({
    writeFiles: (project, files) => writeFilesImpl(project, files),
  }),
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: (id) => `.codex-workspaces/${id}`,
  RunnerError: class RunnerError extends Error {},
});

// Other router imports that would touch IO — inert stubs.
mockResolvedModule(require.resolve('../src/services/codex/event-store'), { createSeqGate: () => ({ shouldEmit: () => true }), listEvents: async () => [] });
mockResolvedModule(require.resolve('../src/services/codex/run-access'), { findOwnedRun: async () => null, isTerminalStatus: () => true });
mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), { createRunSubscriber: async () => null, publishEvent: async () => false });

const codexRoutes = require('../src/routes/codex');

after(() => {
  restoreAuth();
  restoreProjectService();
  restoreRunService();
  restoreRunner();
  delete process.env.CODEX_AGENT_V2;
});
beforeEach(() => {
  process.env.CODEX_AGENT_V2 = '1';
  serviceCalls.length = 0;
  runnerCalls.length = 0;
  writeFilesImpl = async (project, files) => {
    runnerCalls.push(['writeFiles', project, files]);
    return { ok: true, written: files.length };
  };
});

function app() {
  const a = express();
  // Higher-than-prod body limit so the per-file/total byte validators (not the
  // JSON parser) are what reject oversized payloads in these tests.
  a.use(express.json({ limit: '12mb' }));
  a.use('/api/codex', codexRoutes);
  return a;
}

const AUTH = { Authorization: 'Bearer test' };
const FILES = [
  { path: 'src/App.tsx', content: 'export default function App() { return null }' },
  { path: 'index.html', content: '<html></html>' },
];

test('flag off ⇒ 404 not_found', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).send({ files: FILES });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('401 without auth', async () => {
  const res = await request(app()).post('/api/codex/projects/p1/files').send({ files: FILES });
  assert.equal(res.status, 401);
  assert.equal(runnerCalls.length, 0);
});

test('403 for a user without codex agent access', async () => {
  const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).set('x-test-user', 'u-3').send({ files: FILES });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'codex_forbidden');
  assert.equal(runnerCalls.length, 0);
});

test('404 for a foreign project (ownership gate)', async () => {
  const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).set('x-test-user', 'u-2').send({ files: FILES });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'project_not_found');
  assert.equal(runnerCalls.length, 0);
  // Ownership was checked with the CALLER's id, not blindly by project id.
  assert.deepEqual(serviceCalls.find((c) => c[0] === 'getProject')[1], { userId: 'u-2', id: 'p1' });
});

test('400 on invalid payloads (missing/empty/non-array/bad items/too many)', async () => {
  for (const payload of [
    {},
    { files: [] },
    { files: 'nope' },
    { files: [{ path: 42, content: 'x' }] },
    { files: [{ path: 'a.txt', content: 7 }] },
    { files: [{ path: '', content: 'x' }] },
    { files: [{ path: `long/${'x'.repeat(600)}.txt`, content: 'x' }] },
    { files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' })) },
  ]) {
    const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).send(payload);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(res.body.error, 'validation_failed');
  }
  assert.equal(runnerCalls.length, 0);
});

test('400 when a single file exceeds 500KB or the batch exceeds 5MB', async () => {
  const big = await request(app())
    .post('/api/codex/projects/p1/files')
    .set(AUTH)
    .send({ files: [{ path: 'big.txt', content: 'x'.repeat(500 * 1024 + 1) }] });
  assert.equal(big.status, 400);
  assert.equal(big.body.error, 'validation_failed');

  const chunk = 'x'.repeat(450 * 1024); // 12 × 450KB ≈ 5.27MB > 5MB, each under the per-file cap
  const total = await request(app())
    .post('/api/codex/projects/p1/files')
    .set(AUTH)
    .send({ files: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.txt`, content: chunk })) });
  assert.equal(total.status, 400);
  assert.equal(total.body.error, 'validation_failed');
  assert.equal(runnerCalls.length, 0);
});

test('409 run_in_progress when the project has an active run', async () => {
  const res = await request(app()).post('/api/codex/projects/p-busy/files').set(AUTH).send({ files: FILES });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'run_in_progress');
  assert.deepEqual(serviceCalls.find((c) => c[0] === 'hasActiveRun'), ['hasActiveRun', 'p-busy']);
  assert.equal(runnerCalls.length, 0);
});

test('happy path: writes the files via the runner and reports the count', async () => {
  const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).send({ files: FILES });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, written: 2 });
  assert.equal(runnerCalls.length, 1);
  const [, project, files] = runnerCalls[0];
  assert.equal(project, 'p1');
  assert.deepEqual(files, FILES);
});

test('502 runner_unreachable when the sidecar write fails', async () => {
  writeFilesImpl = async () => { throw new Error('runner unreachable: boom'); };
  const res = await request(app()).post('/api/codex/projects/p1/files').set(AUTH).send({ files: FILES });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'runner_unreachable');
});
