'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const restoreAuth = mockResolvedModule(require.resolve('../src/middleware/auth'), {
  authenticateToken(req, _res, next) { req.user = { id: 'u-1', isAdmin: true, isSuperAdmin: false }; next(); },
});

class RunServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const calls = [];
let createImpl = async (args) => ({ id: 'run-1', projectId: args.projectId, mode: args.mode, status: 'queued' });
const restoreRunService = mockResolvedModule(require.resolve('../src/services/codex/run-service'), {
  RunServiceError,
  createRun: async (args) => { calls.push(['createRun', args]); return createImpl(args); },
  cancelRun: async (args) => { calls.push(['cancelRun', args]); return { id: args.runId, status: 'cancelled' }; },
  getRun: async (args) => { calls.push(['getRun', args]); return args.runId === 'run-1' ? { id: 'run-1', projectId: 'p1', status: 'done' } : null; },
  listRuns: async (args) => { calls.push(['listRuns', args]); return [{ id: 'run-1', projectId: args.projectId, status: 'done' }]; },
});

// Other route imports — stub the ones that would hit IO; leave them inert.
mockResolvedModule(require.resolve('../src/services/codex/project-service'), { createProject: async () => ({}), listProjects: async () => [], getProject: async () => null });
mockResolvedModule(require.resolve('../src/services/codex/runner-client'), { createRunnerClient: () => ({}), runnerDevUrl: () => 'http://localhost:5173', RunnerError: class extends Error {} });
mockResolvedModule(require.resolve('../src/services/codex/event-store'), { createSeqGate: () => ({ shouldEmit: () => true }), listEvents: async () => [] });
mockResolvedModule(require.resolve('../src/services/codex/run-access'), { findOwnedRun: async () => null, isTerminalStatus: () => true });
mockResolvedModule(require.resolve('../src/services/codex/redis-pubsub'), { createRunSubscriber: async () => null, publishEvent: async () => false });

const codexRoutes = require('../src/routes/codex');

after(() => { restoreAuth(); restoreRunService(); delete process.env.CODEX_AGENT_V2; });
beforeEach(() => { process.env.CODEX_AGENT_V2 = '1'; calls.length = 0; createImpl = async (args) => ({ id: 'run-1', projectId: args.projectId, mode: args.mode, status: 'queued' }); });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/codex', codexRoutes);
  return a;
}

test('flag off ⇒ run routes are 404', async () => {
  delete process.env.CODEX_AGENT_V2;
  const r1 = await request(app()).post('/api/codex/projects/p1/runs').send({ mode: 'plan' });
  assert.equal(r1.status, 404);
  const r2 = await request(app()).post('/api/codex/runs/run-1/cancel');
  assert.equal(r2.status, 404);
});

test('POST /projects/:id/runs validates mode and forwards userId+projectId', async () => {
  const bad = await request(app()).post('/api/codex/projects/p1/runs').send({});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_failed');

  const res = await request(app()).post('/api/codex/projects/p1/runs').send({ mode: 'plan', prompt: 'hola' });
  assert.equal(res.status, 201);
  assert.equal(res.body.run.id, 'run-1');
  const call = calls.find((c) => c[0] === 'createRun')[1];
  assert.equal(call.userId, 'u-1');
  assert.equal(call.projectId, 'p1');
  assert.equal(call.mode, 'plan');
  assert.equal(call.prompt, 'hola');
});

test('createRun service errors are mapped to their HTTP status', async () => {
  createImpl = async () => { throw new RunServiceError('run_in_progress', 'busy', 409); };
  const res = await request(app()).post('/api/codex/projects/p1/runs').send({ mode: 'plan' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'run_in_progress');
});

// Re-planning (G4): the endpoint forwards feedback + priorPlanRunId to the
// service. A too-long feedback is rejected by validation before the service;
// a foreign priorPlanRunId is rejected by the service and mapped to its status.
test('POST /projects/:id/runs forwards feedback + priorPlanRunId to the service', async () => {
  const res = await request(app())
    .post('/api/codex/projects/p1/runs')
    .send({ mode: 'plan', priorPlanRunId: 'plan-prev', feedback: 'agrega carrito' });
  assert.equal(res.status, 201);
  const call = calls.find((c) => c[0] === 'createRun')[1];
  assert.equal(call.priorPlanRunId, 'plan-prev');
  assert.equal(call.feedback, 'agrega carrito');
  assert.equal(call.mode, 'plan');
});

test('POST /projects/:id/runs rejects feedback > 4000 chars with validation_failed', async () => {
  const res = await request(app())
    .post('/api/codex/projects/p1/runs')
    .send({ mode: 'plan', feedback: 'x'.repeat(4001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'validation_failed');
  // Validation short-circuits before the service is ever called.
  assert.equal(calls.find((c) => c[0] === 'createRun'), undefined);
});

test('POST /projects/:id/runs maps a foreign priorPlanRunId service error to 400', async () => {
  createImpl = async () => { throw new RunServiceError('invalid_prior_plan_run', 'not yours', 400); };
  const res = await request(app())
    .post('/api/codex/projects/p1/runs')
    .send({ mode: 'plan', priorPlanRunId: 'someone-elses', feedback: 'x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_prior_plan_run');
});

test('POST /runs/:id/cancel calls the service', async () => {
  const res = await request(app()).post('/api/codex/runs/run-1/cancel');
  assert.equal(res.status, 200);
  assert.equal(res.body.run.status, 'cancelled');
  assert.deepEqual(calls.find((c) => c[0] === 'cancelRun')[1], { userId: 'u-1', runId: 'run-1' });
});

test('GET /projects/:id/runs/:runId 404s when the run is not in that project', async () => {
  const ok = await request(app()).get('/api/codex/projects/p1/runs/run-1');
  assert.equal(ok.status, 200);
  const mismatch = await request(app()).get('/api/codex/projects/OTHER/runs/run-1');
  assert.equal(mismatch.status, 404);
});

test('GET /projects/:id/runs lists project runs', async () => {
  const res = await request(app()).get('/api/codex/projects/p1/runs');
  assert.equal(res.status, 200);
  assert.equal(res.body.runs.length, 1);
});
