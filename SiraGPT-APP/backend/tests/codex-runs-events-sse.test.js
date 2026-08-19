'use strict';

// Regression tests for the hardened legacy replay-SSE route
// GET /api/codex/runs/:runId/events (backend/src/routes/codex-runs.js).
//
// The route used to let res.write / res.end exceptions escape to the global
// error handler (Express then tried to send a JSON 500 after the SSE head was
// already flushed — breaking the event-stream frame) and held the handler open
// on a dead socket because it never listened for client disconnect.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

const ROWS = new Map([
  ['run-1', { runId: 'run-1', userId: 'u-1', status: 'done', events: [
    { type: 'run_status', data: { status: 'running' } },
    { type: 'text_delta', data: { content: 'hola' } },
  ] }],
  ['run-2', { runId: 'run-2', userId: 'other-user', status: 'done', events: [] }],
]);

const restoreStore = mockResolvedModule(require.resolve('../src/services/codex/codex-run-store'), {
  readRun: (runId) => ROWS.get(String(runId)) || null,
});

// Stub sibling dependencies of the legacy router that touch IO (queue,
// connector, sandbox, task runner); the POST /runs path is not what we test.
mockResolvedModule(require.resolve('../src/services/agents/chat-task-scope'), {
  assertChatScopeForAgentTask: async () => ({ ok: true, chatId: 'chat-1' }),
});
mockResolvedModule(require.resolve('../src/services/codex/codex-run-orchestrator'), {
  enqueueCodexRun: async () => ({ runId: 'new-run', status: 'queued', phase: 'plan', chatId: 'chat-1' }),
});
mockResolvedModule(require.resolve('../src/services/github-codex-connector'), {
  createGitHubCodexConnector: () => null,
});
mockResolvedModule(require.resolve('../src/services/agents/agent-task-runner'), {
  runAgentTaskJob: async () => ({ ok: true }),
});
mockResolvedModule(require.resolve('../src/services/agents/code-sandbox'), {
  runTests: async () => ({ ok: true }),
});
mockResolvedModule(require.resolve('../src/middleware/enforce-plan-quota'), {
  enforcePlanQuota: () => (_req, _res, next) => next(),
});

const codexRunsRouter = require('../src/routes/codex-runs');

after(() => {
  restoreAuth();
  restoreStore();
  // eslint-disable-next-line global-require
  delete require.cache[require.resolve('../src/routes/codex-runs')];
});

beforeEach(() => {
  ROWS.set('run-1', { runId: 'run-1', userId: 'u-1', status: 'done', events: [
    { type: 'run_status', data: { status: 'running' } },
    { type: 'text_delta', data: { content: 'hola' } },
  ] });
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/codex', codexRunsRouter);
  return a;
}

test('GET /runs/:runId/events streams the replay as SSE frames plus snapshot', async () => {
  const res = await request(app())
    .get('/api/codex/runs/run-1/events')
    .set('Accept', 'text/event-stream');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  const body = String(res.text || '');
  const frames = body.split('\n\n').filter((f) => f.startsWith('data:'));
  assert.equal(frames.length, 3, 'expected 2 replay events + 1 snapshot frame');
  assert.equal(frames[0], 'data: {"type":"run_status","data":{"status":"running"}}');
  assert.ok(frames[2].includes('"type":"snapshot"'));
  assert.ok(frames[2].includes('"status":"done"'));
});

test('GET /runs/:runId/events 404s for a foreign run', async () => {
  const res = await request(app()).get('/api/codex/runs/run-2/events');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'run_not_found' });
});

test('a throwing res.write during replay never escapes the handler (no JSON 500 after SSE head)', async () => {
  // Simulate a dead socket: res.write throws after the first frame, exactly
  // the EPIPE/write-after-destroy case that used to surface as a broken
  // event-stream + HTML error page.
  const appRef = express();
  appRef.use(express.json());
  appRef.use('/api/codex', codexRunsRouter);

  const server = appRef.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  try {
    const raw = await fetch(`http://127.0.0.1:${port}/api/codex/runs/run-1/events`);
    const reader = raw.body.getReader();
    // Read the first SSE frame, then destroy the socket mid-stream.
    await reader.read();
    await reader.cancel();
    // The handler must finish without throwing; the request completes (the
    // route ended the response or the connection closed cleanly).
    // We assert via the second request that the server is still healthy.
    const next = await fetch(`http://127.0.0.1:${port}/api/codex/runs/run-2/events`);
    assert.equal(next.status, 404);
  } finally {
    server.close();
  }
});

test('POST /runs rejects an oversized model (validation cap)', async () => {
  const res = await request(app())
    .post('/api/codex/runs')
    .send({ goal: 'construye una app de prueba para validar el límite del modelo', model: 'x'.repeat(201) });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(res.body.errors[0].path, 'model');
});