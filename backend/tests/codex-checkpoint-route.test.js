'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1' }; next(); },
});

const calls = [];
const restoreCp = mockResolvedModule(require.resolve('../src/services/codex/checkpoint-service'), {
  rollbackCheckpoint: async (a) => { calls.push(['rollback', a]); return a.checkpointId === 'cp-1' ? { ok: true, commitSha: 'abc1234', restarted: false } : { error: 'not_found', status: 404 }; },
  getCheckpointDiff: async (a) => { calls.push(['diff', a]); return a.checkpointId === 'cp-1' ? { ok: true, diff: 'diff…', additions: 3, deletions: 1, filesChanged: 1 } : { error: 'not_found', status: 404 }; },
  listCheckpoints: async (a) => { calls.push(['list', a]); return a.projectId === 'p1' ? [{ id: 'cp-1', shortSha: 'abc1234', title: 'feat: x', createdAt: new Date(), additions: 3, deletions: 1 }] : null; },
});

// Inert stubs for the route's other imports.
mockResolvedModule(require.resolve('../src/services/codex/project-service'), { createProject: async () => ({}), listProjects: async () => [], getProject: async () => null });
mockResolvedModule(require.resolve('../src/services/codex/runner-client'), { createRunnerClient: () => ({}), runnerDevUrl: () => 'http://localhost:5173', RunnerError: class extends Error {} });
mockResolvedModule(require.resolve('../src/services/codex/run-service'), { RunServiceError: class extends Error {}, createRun: async () => ({}), cancelRun: async () => ({}), getRun: async () => null, listRuns: async () => [] });
mockResolvedModule(require.resolve('../src/services/codex/event-store'), { createSeqGate: () => ({ shouldEmit: () => true }), listEvents: async () => [] });
mockResolvedModule(require.resolve('../src/services/codex/run-access'), { findOwnedRun: async () => null, isTerminalStatus: () => true });
mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), { createRunSubscriber: async () => null, publishEvent: async () => false });

const codexRoutes = require('../src/routes/codex');

after(() => { restoreAuth(); restoreCp(); delete process.env.CODEX_AGENT_V2; });
beforeEach(() => { process.env.CODEX_AGENT_V2 = '1'; calls.length = 0; });

function app() { const a = express(); a.use(express.json()); a.use('/api/codex', codexRoutes); return a; }

test('flag off ⇒ checkpoint routes are 404', async () => {
  delete process.env.CODEX_AGENT_V2;
  const r = await request(app()).post('/api/codex/checkpoints/cp-1/rollback');
  assert.equal(r.status, 404);
});

test('POST /checkpoints/:id/rollback returns the result and forwards userId', async () => {
  const res = await request(app()).post('/api/codex/checkpoints/cp-1/rollback');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.find((c) => c[0] === 'rollback')[1].userId, 'u-1');
});

test('rollback of a foreign/missing checkpoint maps to 404', async () => {
  const res = await request(app()).post('/api/codex/checkpoints/nope/rollback');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('GET /checkpoints/:id/diff returns unified diff + shortstat', async () => {
  const res = await request(app()).get('/api/codex/checkpoints/cp-1/diff');
  assert.equal(res.status, 200);
  assert.equal(res.body.additions, 3);
  assert.match(res.body.diff, /diff/);
});

test('GET /projects/:id/checkpoints lists; 404 for a non-owned project', async () => {
  const ok = await request(app()).get('/api/codex/projects/p1/checkpoints');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.checkpoints.length, 1);
  const miss = await request(app()).get('/api/codex/projects/other/checkpoints');
  assert.equal(miss.status, 404);
});
