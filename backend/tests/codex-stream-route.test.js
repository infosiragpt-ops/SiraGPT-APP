'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Minimal real seq gate so dedup behaves like production.
function realGate() {
  const seen = new Set();
  return { shouldEmit: (s) => (typeof s !== 'number' ? true : seen.has(s) ? false : (seen.add(s), true)), seenCount: () => seen.size };
}

const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

let scriptedEvents = [];
const restoreStore = mockResolvedModule(require.resolve('../src/services/codex/event-store'), {
  createSeqGate: realGate,
  listEvents: async (runId, { afterSeq = 0 } = {}) => scriptedEvents.filter((e) => e.seq > afterSeq),
});

let ownedRun = null;
const restoreAccess = mockResolvedModule(require.resolve('../src/services/codex/run-access'), {
  findOwnedRun: async ({ runId, userId }) => (ownedRun && ownedRun.userId === userId && ownedRun.id === runId ? ownedRun : null),
  isTerminalStatus: (s) => ['done', 'error', 'cancelled'].includes(String(s || '')),
});

const restorePubsub = mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), {
  createRunSubscriber: async () => null, // Redis off ⇒ replay-only path
  publishEvent: async () => false,
});

// project-service + runner-client are imported by the route too; stub them out.
const restoreService = mockResolvedModule(require.resolve('../src/services/codex/project-service'), {
  createProject: async () => ({}), listProjects: async () => [], getProject: async () => null,
});
const restoreRunner = mockResolvedModule(require.resolve('../src/services/codex/runner-client'), {
  createRunnerClient: () => ({}), runnerDevUrl: () => 'http://localhost:5173', RunnerError: class extends Error {},
});

const codexRoutes = require('../src/routes/codex');

after(() => {
  restoreAuth(); restoreStore(); restoreAccess(); restorePubsub(); restoreService(); restoreRunner();
  delete process.env.CODEX_AGENT_V2;
});
beforeEach(() => { process.env.CODEX_AGENT_V2 = '1'; ownedRun = null; scriptedEvents = []; });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/codex', codexRoutes);
  return a;
}

test('stream 404s for a run the user does not own', async () => {
  ownedRun = { id: 'run-1', userId: 'someone-else', status: 'done' };
  const res = await request(app()).get('/api/codex/runs/run-1/stream');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'run_not_found');
});

test('stream replays a terminal run with SSE headers then ends', async () => {
  ownedRun = { id: 'run-1', userId: 'u-1', status: 'done' };
  scriptedEvents = [
    { runId: 'run-1', seq: 1, ts: 't', type: 'run_status', data: { status: 'running' } },
    { runId: 'run-1', seq: 2, ts: 't', type: 'narrative_delta', data: { text: 'hola' } },
    { runId: 'run-1', seq: 3, ts: 't', type: 'run_status', data: { status: 'done' } },
  ];
  const res = await request(app()).get('/api/codex/runs/run-1/stream');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  // All three events present, terminal status closes the stream.
  assert.match(res.text, /"seq":1/);
  assert.match(res.text, /"text":"hola"/);
  assert.match(res.text, /"status":"done"/);
});

test('stream replays only events after afterSeq', async () => {
  ownedRun = { id: 'run-1', userId: 'u-1', status: 'done' };
  scriptedEvents = [
    { runId: 'run-1', seq: 1, ts: 't', type: 'narrative_delta', data: { text: 'a' } },
    { runId: 'run-1', seq: 2, ts: 't', type: 'narrative_delta', data: { text: 'b' } },
    { runId: 'run-1', seq: 3, ts: 't', type: 'run_status', data: { status: 'done' } },
  ];
  const res = await request(app()).get('/api/codex/runs/run-1/stream?afterSeq=1');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /"text":"a"/); // seq 1 skipped
  assert.match(res.text, /"text":"b"/);
  assert.match(res.text, /"status":"done"/);
});
