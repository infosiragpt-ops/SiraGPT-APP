'use strict';

// POST /api/codex/projects/:id/exec — project-terminal exec via the sandbox
// sidecar. Contract tests with the real router + fake services injected via
// require.cache (same offline pattern as codex-project-files-route.test.js).

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

// u-1 owns p1. Everything else → not found.
const serviceCalls = [];
const restoreProjectService = mockResolvedModule(require.resolve('../src/services/codex/project-service'), {
  createProject: async () => ({}),
  listProjects: async () => [],
  getProject: async (args) => {
    serviceCalls.push(['getProject', args]);
    if (args.userId !== 'u-1') return null;
    if (args.id === 'p1') return { id: 'p1', name: 'A', status: 'ready' };
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
  hasActiveRun: async () => false,
});

class RunnerError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.status = status;
    this.body = body;
  }
}

const runnerCalls = [];
let execImpl;
function makeClient() {
  const client = {
    exec: (project, cmd, opts) => execImpl(project, cmd, opts),
  };
  client.forRun = (runId, projectId) => {
    runnerCalls.push(['forRun', runId, projectId]);
    return {
      exec: (project, cmd, opts) => execImpl(project, cmd, opts, { scopedTo: runId }),
    };
  };
  return client;
}
execImpl = async () => ({ ok: true, exitCode: 0 });

const restoreRunner = mockResolvedModule(require.resolve('../src/services/codex/runner-client'), {
  createRunnerClient: () => makeClient(),
  runnerDevUrl: () => 'http://localhost:5173',
  codexExportHostPath: (id) => `.codex-workspaces/${id}`,
  RunnerError,
});
// The route resolves the sandbox through the provider facade; the shared
// provider just wraps runner-client, so stub the facade to hand back the same
// fake client and keep these tests fully offline.
mockResolvedModule(require.resolve('../src/services/codex/sandbox-provider'), {
  DEFAULT_PROVIDER_ID: 'shared-runner',
  selectedProviderId: () => 'shared-runner',
  getSandboxRuntime: () => ({}),
  createSandboxClient: () => makeClient(),
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
  execImpl = async () => ({ ok: true, exitCode: 0 });
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/codex', codexRoutes);
  return a;
}

const AUTH = { Authorization: 'Bearer test' };
const URL = '/api/codex/projects/p1/exec';

test('flag off ⇒ 404 not_found', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['ls'] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('401 without auth', async () => {
  const res = await request(app()).post(URL).send({ cmd: ['ls'] });
  assert.equal(res.status, 401);
  assert.equal(runnerCalls.length, 0);
});

test('403 for a user without codex agent access', async () => {
  const res = await request(app()).post(URL).set(AUTH).set('x-test-user', 'u-3').send({ cmd: ['ls'] });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'codex_forbidden');
  assert.equal(runnerCalls.length, 0);
});

test('404 for a foreign project (ownership gate)', async () => {
  const res = await request(app()).post(URL).set(AUTH).set('x-test-user', 'u-2').send({ cmd: ['ls'] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'project_not_found');
  assert.equal(runnerCalls.length, 0);
  // Ownership was checked with the CALLER's id, not blindly by project id.
  assert.deepEqual(serviceCalls.find((c) => c[0] === 'getProject')[1], { userId: 'u-2', id: 'p1' });
});

test('400 on invalid payloads', async () => {
  for (const payload of [
    {},
    { cmd: [] },
    { cmd: 'ls -la' },
    { cmd: [42] },
    { cmd: [''] },
    { cmd: ['ls', 7] },
    { cmd: ['x'.repeat(4001)] },
    { cmd: Array.from({ length: 65 }, () => 'a') },
    { run: 7, cmd: ['ls'] },
    { timeoutMs: 999, cmd: ['ls'] },
    { timeoutMs: 121_000, cmd: ['ls'] },
  ]) {
    const res = await request(app()).post(URL).set(AUTH).send(payload);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(res.body.error, 'validation_failed');
  }
  assert.equal(runnerCalls.length, 0);
});

test('happy path: runs the argv array via the sandbox and returns the standard shape', async () => {
  let seen;
  execImpl = async (project, cmd, opts) => {
    seen = { project, cmd, opts };
    return { ok: true, exitCode: 0, timedOut: false, stdout: 'src/\npackage.json\n', stderr: '', durationMs: 12 };
  };
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['ls', '-la'], timeoutMs: 45_000 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, exitCode: 0, timedOut: false, stdout: 'src/\npackage.json\n', stderr: '' });
  assert.equal(seen.project, 'p1');
  assert.deepEqual(seen.cmd, ['ls', '-la']);
  assert.deepEqual(seen.opts, { timeoutMs: 45_000 });
  // No `run` ⇒ unscoped client, no worktree scoping.
  assert.equal(runnerCalls.filter((c) => c[0] === 'forRun').length, 0);
});

test('run scoping: forwards the run so the exec lands in wt-<run>', async () => {
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['git', 'status'], run: 'run123' });
  assert.equal(res.status, 200);
  assert.deepEqual(runnerCalls.find((c) => c[0] === 'forRun'), ['forRun', 'run123', 'p1']);
});

test('nonzero exit is still a 200 with ok:false + exitCode', async () => {
  execImpl = async () => ({ ok: false, exitCode: 2, timedOut: false, stdout: '', stderr: 'fatal: not a git repository' });
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['git', 'status'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.exitCode, 2);
  assert.match(res.body.stderr, /not a git repository/);
});

test('timeout result maps to ok:false + timedOut:true', async () => {
  execImpl = async () => ({ ok: false, exitCode: null, timedOut: true, stdout: 'partial', stderr: '' });
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['npm', 'install'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.timedOut, true);
  assert.equal(res.body.stdout, 'partial');
});

test('sidecar 404 workspace → 404 workspace_not_found; sidecar 409 → 409 passthrough', async () => {
  const err404 = new RunnerError('worktree_not_found', { status: 404, body: { error: 'worktree_not_found' } });
  execImpl = async () => { throw err404; };
  const notFound = await request(app()).post(URL).set(AUTH).send({ cmd: ['ls'], run: 'gone' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error, 'workspace_not_found');

  const err409 = new RunnerError('workspace_unavailable', { status: 409, body: { error: 'project_locked' } });
  execImpl = async () => { throw err409; };
  const locked = await request(app()).post(URL).set(AUTH).send({ cmd: ['ls'] });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, 'project_locked');
});

test('runner unreachable → 502 runner_unreachable', async () => {
  execImpl = async () => { throw new RunnerError('runner unreachable: boom', { status: 0 }); };
  const res = await request(app()).post(URL).set(AUTH).send({ cmd: ['ls'] });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'runner_unreachable');
});
