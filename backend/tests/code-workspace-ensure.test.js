'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

const {
  WORKSPACE_ERROR_CODES,
  classifyWorkspaceError,
  buildsMismatch,
  toPublicEnsureError,
} = require('../src/services/code/workspace-errors');
const { createWorkspaceEnsure, createEnsureStore } = require('../src/services/code/workspace-ensure');
const { createCodeWorkspacesRouter } = require('../src/routes/code-workspaces');

function startServer(router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'trace-test-1';
    req.id = 'trace-test-1';
    next();
  });
  app.use('/api/code', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('classifyWorkspaceError never leaves a raw unknown as the only UI copy', () => {
  const payload = classifyWorkspaceError(new Error('boom from fs'));
  assert.equal(payload.code, WORKSPACE_ERROR_CODES.UNKNOWN);
  assert.ok(payload.userMessage.includes('espacio de código'));
  assert.notEqual(payload.userMessage, payload.internalMessage);
  assert.equal(payload.retryable, false);
  assert.equal(typeof payload.traceId, 'string');
});

test('classifyWorkspaceError maps transient HTTP statuses as retryable', () => {
  for (const status of [408, 429, 500, 502, 503]) {
    const payload = classifyWorkspaceError({ status, message: 'upstream' });
    assert.equal(payload.retryable, true, `status ${status} should be retryable`);
    assert.ok(payload.userMessage);
    assert.notEqual(payload.userMessage, 'upstream');
  }
});

test('classifyWorkspaceError maps 401 and ChunkLoadError to structured codes', () => {
  const session = classifyWorkspaceError({ status: 401 });
  assert.equal(session.code, WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED);
  assert.equal(session.status, 401);
  const chunk = classifyWorkspaceError({ name: 'ChunkLoadError', message: 'Loading chunk 17 failed' });
  assert.equal(chunk.code, WORKSPACE_ERROR_CODES.CHUNK_LOAD_ERROR);
  assert.equal(chunk.retryable, true);
});

test('public error payload never includes internalMessage', () => {
  const classified = classifyWorkspaceError(new Error('/tmp/secret-path ENOENT'));
  const published = toPublicEnsureError(classified);
  assert.equal(published.internalMessage, undefined);
  assert.ok(published.userMessage);
  assert.equal(published.code, classified.code);
});

test('buildsMismatch ignores unknown or empty ids', () => {
  assert.equal(buildsMismatch('', 'abc'), false);
  assert.equal(buildsMismatch('unknown', 'abc'), false);
  assert.equal(buildsMismatch('abc', 'abc'), false);
  assert.equal(buildsMismatch('abc', 'def'), true);
});

test('ensure is idempotent and does not start a second runtime', async () => {
  let startCalls = 0;
  const hostRunner = {
    startRun: async () => {
      startCalls += 1;
      return { runId: 'r1', phase: 'installing' };
    },
    getStatus: () => ({ running: true, ready: false, phase: 'installing', error: null }),
  };
  const ensure = createWorkspaceEnsure({
    hostRunner,
    store: createEnsureStore(),
    resolveBuild: () => 'build-a',
  });

  const first = await ensure.ensureWorkspace({
    userId: 'user-1',
    idempotencyKey: 'code-ws-stable-key-1',
    runtimeId: 'r1',
    folderId: 'project:abc',
    traceId: 't1',
  });
  const second = await ensure.ensureWorkspace({
    userId: 'user-1',
    idempotencyKey: 'code-ws-stable-key-1',
    runtimeId: 'r1',
    folderId: 'project:abc',
    traceId: 't2',
  });

  assert.equal(first.httpStatus, 202);
  assert.equal(first.body.status, 'PENDING');
  assert.equal(first.body.runtimeId, 'r1');
  assert.equal(second.httpStatus, 202);
  assert.equal(second.body.workspaceId, first.body.workspaceId);
  assert.equal(startCalls, 0, 'Retry must not call startRun');
});

test('ensure returns READY for a local folder without minting a runtime', async () => {
  const ensure = createWorkspaceEnsure({
    hostRunner: { startRun: async () => { throw new Error('should not start'); } },
    resolveBuild: () => 'build-a',
  });
  const result = await ensure.ensureWorkspace({
    userId: 'user-1',
    idempotencyKey: 'code-ws-local-key-1',
    localId: 'local:notes',
    traceId: 't-local',
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, 'READY');
  assert.equal(result.body.runtimeId, null);
});

test('ensure returns 409 CLIENT_BUILD_MISMATCH when both builds are known', async () => {
  const ensure = createWorkspaceEnsure({ resolveBuild: () => 'server-build' });
  const result = await ensure.ensureWorkspace({
    userId: 'user-1',
    idempotencyKey: 'code-ws-mismatch-key-1',
    clientBuild: 'client-build',
    traceId: 't-mismatch',
  });
  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.code, WORKSPACE_ERROR_CODES.CLIENT_BUILD_MISMATCH);
  assert.equal(result.body.retryable, true);
  assert.ok(result.body.userMessage);
  assert.equal(result.body.internalMessage, undefined);
});

test('ensure response shapes cover READY / 202 / 401 / 422', async () => {
  const ensure = createWorkspaceEnsure({ resolveBuild: () => '' });
  const router = createCodeWorkspacesRouter({
    authenticateToken: (req, _res, next) => {
      req.user = req.headers['x-user'] ? { id: req.headers['x-user'] } : null;
      next();
    },
    ensure,
    metrics: { counter() {} },
  });
  const { server, port } = await startServer(router);
  try {
    const ready = await request(port, {
      method: 'POST',
      path: '/api/code/workspaces/ensure',
      headers: { 'Idempotency-Key': 'code-ws-shape-ready-1', 'x-user': 'u1' },
      body: { localId: 'local:desk' },
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'READY');
    assert.equal(ready.body.ok, true);
    assert.equal(typeof ready.body.workspaceId, 'string');
    assert.equal(ready.body.stage, 'READY');

    const installing = createWorkspaceEnsure({
      hostRunner: {
        getStatus: () => ({ phase: 'starting', ready: false, running: true }),
      },
      resolveBuild: () => '',
    });
    const pendingRouter = createCodeWorkspacesRouter({
      authenticateToken: (req, _res, next) => {
        req.user = { id: 'u1' };
        next();
      },
      ensure: installing,
    });
    const pendingServer = await startServer(pendingRouter);
    try {
      const pending = await request(pendingServer.port, {
        method: 'POST',
        path: '/api/code/workspaces/ensure',
        headers: { 'Idempotency-Key': 'code-ws-shape-pending-1' },
        body: { runtimeId: 'run-1', folderId: 'folder-1' },
      });
      assert.equal(pending.status, 202);
      assert.equal(pending.body.status, 'PENDING');
      assert.equal(pending.body.retryable, true);
      assert.ok(pending.body.progress);
      assert.ok(pending.body.retryAfterMs > 0);
    } finally {
      pendingServer.server.close();
    }

    const noUser = await request(port, {
      method: 'POST',
      path: '/api/code/workspaces/ensure',
      headers: { 'Idempotency-Key': 'code-ws-shape-401-xx' },
      body: {},
    });
    assert.equal(noUser.status, 401);
    assert.equal(noUser.body.code, WORKSPACE_ERROR_CODES.SESSION_REFRESH_REQUIRED);

    const badKey = await request(port, {
      method: 'POST',
      path: '/api/code/workspaces/ensure',
      headers: { 'x-user': 'u1', 'Idempotency-Key': 'bad' },
      body: {},
    });
    assert.equal(badKey.status, 422);
    assert.equal(badKey.body.code, WORKSPACE_ERROR_CODES.INVALID_REQUEST);
  } finally {
    server.close();
  }
});
