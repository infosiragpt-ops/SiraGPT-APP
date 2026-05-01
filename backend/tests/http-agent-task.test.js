const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const {
  buildRouteTestApp,
  createContractValidator,
  installAuthSessionMock,
  reloadModule,
} = require('./http-test-utils');

const assertContractResponse = createContractValidator();

function rememberEnv(keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('HTTP agent task route', () => {
  let auth;
  let restoreEnv;
  let taskStoreDir;

  beforeEach(() => {
    auth = installAuthSessionMock();
    restoreEnv = rememberEnv(['OPENAI_API_KEY', 'REDIS_URL', 'AGENT_TASK_INLINE', 'AGENT_TASK_STORE_DIR']);
    taskStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-agent-task-http-'));
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
    delete process.env.REDIS_URL;
    delete process.env.AGENT_TASK_INLINE;
    process.env.AGENT_TASK_STORE_DIR = taskStoreDir;
    delete require.cache[require.resolve('../src/routes/agent-task')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/routes/agent-task')];
    fs.rmSync(taskStoreDir, { recursive: true, force: true });
    restoreEnv();
    auth.restore();
  });

  function buildApp() {
    return buildRouteTestApp('/api/agent', reloadModule('../src/routes/agent-task'));
  }

  test('requires auth before creating an agent task', async () => {
    const res = await request(buildApp())
      .post('/api/agent/task')
      .send({ goal: 'Write a short report' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Access token required');
  });

  test('validates task creation body at the HTTP boundary', async () => {
    const res = await request(buildApp())
      .post('/api/agent/task')
      .set('Authorization', auth.authHeader)
      .send({ goal: 'no', maxRuntimeMs: 10 });

    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
    assertContractResponse('agent.task.create', 400, res.body);
  });

  test('returns the documented 503 contract when Redis queueing is unavailable', async () => {
    const res = await request(buildApp())
      .post('/api/agent/task')
      .set('Authorization', auth.authHeader)
      .send({ goal: 'Build a verified task plan', maxSteps: 3, maxRuntimeMs: 60000 });

    assert.equal(res.status, 503);
    assert.match(res.body.error, /REDIS_URL is required/);
    assertContractResponse('agent.task.create', 503, res.body);
  });

  test('reads durable task status for the authenticated owner', async () => {
    const taskStore = require('../src/services/agents/task-store');
    taskStore.writeTaskSnapshot({
      taskId: 'task-http-1',
      userId: auth.user.id,
      displayGoal: 'Inspect status',
      agentGoal: 'Inspect status',
      status: 'queued',
      queueName: 'agent-tasks',
      traceId: 'trace-http-1',
      streamState: { steps: [], artifacts: [], finalText: '', done: false },
      events: [{ type: 'queue_status', status: 'queued', seq: 1 }],
      lastEventSeq: 1,
    });

    const res = await request(buildApp())
      .get('/api/agent/task/task-http-1')
      .set('Authorization', auth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.taskId, 'task-http-1');
    assert.equal(res.body.status, 'queued');
    assertContractResponse('agent.task.status', 200, res.body);
  });
});

describe('HTTP admin queue route', () => {
  let restoreEnv;
  let adminAuth;
  let userAuth;

  beforeEach(() => {
    restoreEnv = rememberEnv(['REDIS_URL']);
    delete process.env.REDIS_URL;
    adminAuth = installAuthSessionMock({ id: 'admin-http-1', email: 'admin-http@example.com', isAdmin: true });
    userAuth = installAuthSessionMock({ id: 'user-http-2', email: 'user-http-2@example.com', isAdmin: false });
    delete require.cache[require.resolve('../src/routes/admin-queues')];
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/routes/admin-queues')];
    userAuth.restore();
    adminAuth.restore();
    restoreEnv();
  });

  function buildApp() {
    return buildRouteTestApp('/api/admin/queues', reloadModule('../src/routes/admin-queues'));
  }

  test('requires admin privileges for queue status', async () => {
    const res = await request(buildApp())
      .get('/api/admin/queues/status')
      .set('Authorization', userAuth.authHeader);

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Admin access required');
    assertContractResponse('admin.queues.status', 403, res.body);
  });

  test('reports disabled queue board cleanly without Redis', async () => {
    const res = await request(buildApp())
      .get('/api/admin/queues/status')
      .set('Authorization', adminAuth.authHeader);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.queueBoard.status, 'disabled');
    assert.equal(res.body.queueBoard.redisUrlConfigured, false);
    assertContractResponse('admin.queues.status', 200, res.body);
  });
});

describe('HTTP health route contract', () => {
  test('returns the liveness contract without touching external dependencies', async () => {
    const {
      reportToHttpStatus,
      runLivenessCheck,
    } = require('../src/services/observability/health-check');
    const app = express();
    app.get('/health/live', (_req, res) => {
      const report = runLivenessCheck();
      res.status(reportToHttpStatus(report)).json(report);
    });

    const res = await request(app).get('/health/live');

    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
    assertContractResponse('health.live', 200, res.body);
  });
});
