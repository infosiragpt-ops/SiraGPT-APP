const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const adminQueues = require('../src/routes/admin-queues');
const { createContractValidator } = require('./http-test-utils');
const {
  DEFAULT_PHYSICAL_QUEUE_NAMES,
  createDefaultQueueRegistry,
  createQueueHealthProbeRuntime,
  createQueueRegistry,
  defaultQueueHealthProbe,
  defaultQueueRegistry,
} = require('../src/services/queues/queue-registry');

const assertContractResponse = createContractValidator();

function authenticateRole(req, _res, next) {
  const role = req.headers['x-test-role'];
  req.user = {
    isAdmin: role === 'admin' || role === 'super',
    isSuperAdmin: role === 'super',
  };
  next();
}

function requireAdminRole(req, res, next) {
  if (!req.user?.isAdmin && !req.user?.isSuperAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdminRole(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

test('admin queue dashboard is disabled cleanly without REDIS_URL', async () => {
  const status = await adminQueues.INTERNAL.buildQueueBoardStatus({
    env: { AGENT_QUEUE_NAME: 'custom-agent-tasks' },
    getSnapshot: async () => ({
      status: 'disabled',
      reason: 'REDIS_URL is not configured',
      queues: DEFAULT_PHYSICAL_QUEUE_NAMES.map((name) => ({
        name,
        status: 'skipped',
        jobs: null,
      })),
    }),
  });

  assert.equal(status.status, 'disabled');
  assert.equal(status.redisUrlConfigured, false);
  assert.equal(status.queue, 'custom-agent-tasks');
  assert.equal(status.queues.length, 5);
});

test('admin queue dashboard reports queue health when Redis is configured', async () => {
  const status = await adminQueues.INTERNAL.buildQueueBoardStatus({
    env: {
      REDIS_URL: 'redis://localhost:6379',
      AGENT_QUEUE_NAME: 'siragpt-agent-tasks',
    },
    getSnapshot: async () => ({
      status: 'ready',
      queues: [{
        name: 'siragpt-agent-tasks',
        jobs: { waiting: 1, active: 0, completed: 4, failed: 0 },
        status: 'ready',
      }],
    }),
  });

  assert.equal(status.status, 'ready');
  assert.equal(status.enabled, true);
  assert.equal(status.basePath, '/api/admin/queues/board');
  assert.equal(status.counts.waiting, 1);
});

test('admin queue dashboard degrades when queue health throws', async () => {
  const status = await adminQueues.INTERNAL.buildQueueBoardStatus({
    env: { REDIS_URL: 'redis://localhost:6379' },
    getSnapshot: async () => ({
      status: 'degraded',
      queues: [{
        name: 'siragpt-agent-tasks',
        jobs: null,
        status: 'degraded',
        lastError: 'redis unavailable',
      }],
    }),
  });

  assert.equal(status.status, 'degraded');
  assert.equal(status.counts, null);
  assert.equal(status.queues[0].lastError, 'redis unavailable');
});

// ── Shared queue registry — /api/admin/queues/health snapshot ────────

test('queues health snapshot lists all five queues as skipped without REDIS_URL', async () => {
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: {},
    registry: createDefaultQueueRegistry({ env: {} }),
  });
  assert.equal(snap.status, 'disabled');
  assert.deepEqual(snap.queues.map((queue) => queue.name), DEFAULT_PHYSICAL_QUEUE_NAMES);
  assert.ok(snap.queues.every((queue) => queue.status === 'skipped'));
  assert.ok(snap.queues.every((queue) => queue.jobs === null));
  assert.match(snap.reason, /REDIS_URL/);
});

test('queues health snapshot enumerates each registered queue with counts + isPaused', async () => {
  const fakeQueue = {
    async getJobCounts(...states) {
      const counts = {};
      for (const s of states) counts[s] = s === 'completed' ? 7 : s === 'waiting' ? 3 : 0;
      return counts;
    },
    async isPaused() { return false; },
  };
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: { REDIS_URL: 'redis://localhost:6379' },
    registry: createQueueRegistry({
      definitions: [{ id: 'agent-task', name: 'physical-agent-tasks', getter: () => fakeQueue }],
    }),
  });
  assert.equal(snap.status, 'ready');
  assert.equal(snap.queues.length, 1);
  const q = snap.queues[0];
  assert.equal(q.name, 'physical-agent-tasks');
  assert.equal(q.isPaused, false);
  assert.deepEqual(q.jobs, {
    waiting: 3, active: 0, completed: 7, failed: 0, delayed: 0, paused: 0,
  });
  assert.equal(q.lastError, null);
});

test('queues health snapshot records lastError when a probe throws', async () => {
  const failing = {
    async getJobCounts() { throw new Error('redis disconnected'); },
    async isPaused() { return false; },
  };
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: { REDIS_URL: 'redis://localhost:6379' },
    registry: createQueueRegistry({
      definitions: [{ name: 'broken-queue', getter: () => failing, critical: false }],
    }),
  });
  assert.equal(snap.status, 'degraded');
  assert.equal(snap.queues[0].status, 'degraded');
  assert.equal(snap.queues[0].jobs, null);
  assert.equal(snap.queues[0].isPaused, null);
  assert.match(snap.queues[0].lastError, /redis disconnected/);
});

test('queues health snapshot is unhealthy when a critical queue probe throws', async () => {
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: { REDIS_URL: 'redis://localhost:6379' },
    registry: createQueueRegistry({
      definitions: [{
        name: 'agent-task',
        getter: () => {
          throw new Error('critical queue disconnected');
        },
        critical: true,
      }],
    }),
  });
  assert.equal(snap.status, 'unhealthy');
  assert.equal(snap.queues[0].status, 'unhealthy');
  assert.equal(snap.queues[0].critical, true);
  assert.match(snap.queues[0].lastError, /critical queue disconnected/);
});

test('queues health snapshot reports paused queue and surfaces it in the payload', async () => {
  const paused = {
    async getJobCounts() {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 12 };
    },
    async isPaused() { return true; },
  };
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: { REDIS_URL: 'redis://localhost:6379' },
    registry: createQueueRegistry({
      definitions: [{ name: 'paused-queue', getter: () => paused }],
    }),
  });
  assert.equal(snap.queues[0].isPaused, true);
  assert.equal(snap.queues[0].jobs.paused, 12);
});

test('admin queue health uses the shared default registry', async () => {
  assert.equal(adminQueues.INTERNAL.queueRegistry, defaultQueueRegistry);
  assert.equal(adminQueues.INTERNAL.queueHealthProbe, defaultQueueHealthProbe);
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: {},
  });
  assert.deepEqual(
    snap.queues.map((queue) => queue.name),
    defaultQueueRegistry.list().map((queue) => queue.name),
  );
});

test('admin /health returns 503 only for unhealthy and retains super-admin details', async () => {
  const allow = (_req, _res, next) => next();
  const cases = [
    ['ready', 200],
    ['degraded', 200],
    ['disabled', 200],
    ['unhealthy', 503],
  ];

  for (const [status, expectedHttp] of cases) {
    const app = express();
    app.use('/api/admin/queues', adminQueues.INTERNAL.createAdminQueuesRouter({
      authenticateMiddleware: allow,
      requireAdminMiddleware: allow,
      requireSuperAdminMiddleware: allow,
      getHealthSnapshot: async () => ({
        status,
        queues: [{
          name: 'physical-agent-tasks',
          jobs: { waiting: 3 },
          isPaused: false,
          lastError: status === 'ready' ? null : 'admin-only detail',
        }],
      }),
    }));

    const response = await request(app).get('/api/admin/queues/health');
    assert.equal(response.status, expectedHttp, status);
    assert.equal(response.body.status, status);
    assert.equal(response.body.queues[0].name, 'physical-agent-tasks');
    assert.equal(response.body.queues[0].jobs.waiting, 3);
  }
});

test('Bull Board builds adapters for all five physical producer queues', () => {
  const producerQueues = DEFAULT_PHYSICAL_QUEUE_NAMES.map((name) => ({ name }));
  let getterCalls = 0;
  const registry = createQueueRegistry({
    definitions: DEFAULT_PHYSICAL_QUEUE_NAMES.map((name, index) => ({
      id: `queue-${index}`,
      name,
      getter: () => {
        getterCalls += 1;
        return producerQueues[index];
      },
    })),
  });
  let boardConfig = null;
  class FakeBullMQAdapter {
    constructor(queue) {
      this.queue = queue;
    }
  }
  class FakeExpressAdapter {
    setBasePath(path) {
      this.basePath = path;
    }
  }

  const runtime = adminQueues.INTERNAL.createBullBoardRuntime({
    registry,
    createBoard(config) {
      boardConfig = config;
    },
    BullMQAdapterClass: FakeBullMQAdapter,
    ExpressAdapterClass: FakeExpressAdapter,
  });

  assert.equal(getterCalls, 5);
  assert.equal(boardConfig.queues.length, 5);
  assert.deepEqual(
    boardConfig.queues.map((adapter) => adapter.queue.name),
    DEFAULT_PHYSICAL_QUEUE_NAMES,
  );
  assert.deepEqual(runtime.queueNames, DEFAULT_PHYSICAL_QUEUE_NAMES);
  assert.equal(runtime.serverAdapter.basePath, '/api/admin/queues/board');
});

test('/status preserves ok compatibility and returns 503 only for unhealthy', async () => {
  const cases = [
    ['ready', 200, true],
    ['degraded', 200, true],
    ['disabled', 200, true],
    ['unhealthy', 503, false],
  ];

  for (const [status, expectedHttp, expectedOk] of cases) {
    let snapshotCalls = 0;
    const snapshot = {
      status,
      queues: [{
        name: 'siragpt-agent-tasks',
        status: status === 'unhealthy' ? 'unhealthy' : status,
        jobs: status === 'ready' ? { waiting: 2 } : null,
      }],
    };
    const app = express();
    app.use('/api/admin/queues', adminQueues.INTERNAL.createAdminQueuesRouter({
      authenticateMiddleware: authenticateRole,
      requireAdminMiddleware: requireAdminRole,
      requireSuperAdminMiddleware: requireSuperAdminRole,
      getHealthSnapshot: async () => {
        snapshotCalls += 1;
        return snapshot;
      },
      getBoardStatus: async () => ({
        status: 'ready',
        queues: [{ name: 'producer-only' }],
      }),
      env: { REDIS_URL: 'redis://configured' },
    }));

    const response = await request(app)
      .get('/api/admin/queues/status')
      .set('x-test-role', 'admin');
    assert.equal(response.status, expectedHttp, status);
    assert.equal(response.body.ok, expectedOk, status);
    assert.equal(response.body.queueBoard.status, status);
    assert.equal(snapshotCalls, 1);
    assertContractResponse('admin.queues.status', expectedHttp, response.body);
  }
});

test('/status retains legacy agent counts and safe queue aggregates without raw details', async () => {
  const app = express();
  app.use('/api/admin/queues', adminQueues.INTERNAL.createAdminQueuesRouter({
    authenticateMiddleware: authenticateRole,
    requireAdminMiddleware: requireAdminRole,
    requireSuperAdminMiddleware: requireSuperAdminRole,
    getHealthSnapshot: async () => ({
      status: 'degraded',
      reason: 'aggregate reason must not leak',
      queues: [
        {
          name: 'siragpt-agent-tasks',
          status: 'ready',
          jobs: { waiting: 2, active: 1, completed: 9, failed: 0, delayed: 0, paused: 0 },
          isPaused: false,
          lastError: null,
        },
        {
          name: 'siragpt-chat-runs',
          status: 'degraded',
          jobs: null,
          isPaused: null,
          lastError: 'redis://private-host:6379 failed with tenant-sensitive detail',
        },
        { name: 'codex-runs', status: 'ready', jobs: { waiting: 7 }, lastError: null },
        { name: 'siragpt-document-collections', status: 'skipped', jobs: null, lastError: null },
        { name: 'siragpt-goal-runs', status: 'unhealthy', critical: true, jobs: null, lastError: 'secret' },
      ],
    }),
    env: {
      REDIS_URL: 'redis://configured',
      AGENT_QUEUE_NAME: 'siragpt-agent-tasks',
    },
  }));

  const response = await request(app)
    .get('/api/admin/queues/status')
    .set('x-test-role', 'admin');

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(response.body.queueBoard.counts, {
    waiting: 2,
    active: 1,
    completed: 9,
    failed: 0,
    delayed: 0,
    paused: 0,
  });
  assert.deepEqual(response.body.queueBoard.queueCounts, {
    total: 5,
    ready: 2,
    degraded: 1,
    unhealthy: 1,
    skipped: 1,
    criticalFailures: 1,
  });
  assert.equal(response.body.queueBoard.queues, undefined);
  assert.equal(response.body.queueBoard.reason, undefined);
  assert.doesNotMatch(
    JSON.stringify(response.body),
    /private-host|tenant-sensitive|lastError|secret/,
  );
});

test('admin queue status response contract accepts unhealthy', () => {
  assertContractResponse('admin.queues.status', 503, {
    ok: false,
    queueBoard: {
      enabled: true,
      redisUrlConfigured: true,
      queue: 'siragpt-agent-tasks',
      basePath: '/api/admin/queues/board',
      status: 'unhealthy',
      counts: null,
      queueCounts: {
        total: 5,
        ready: 4,
        degraded: 0,
        unhealthy: 1,
        skipped: 0,
        criticalFailures: 1,
      },
    },
  });
});

test('/status recovers with a fresh dedicated connection after a non-timeout failure', async () => {
  const connections = [];
  let queueCreations = 0;
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{
        name: 'physical-chat-runs',
        critical: false,
        getter: () => { throw new Error('producer queue must remain untouched'); },
      }],
    }),
    env: { REDIS_URL: 'redis://configured' },
    cacheTtlMs: 0,
    createConnection: () => {
      const connection = {
        disconnects: 0,
        on() {},
        disconnect() { this.disconnects += 1; },
        async quit() {},
      };
      connections.push(connection);
      return connection;
    },
    createQueue: () => {
      queueCreations += 1;
      if (queueCreations === 1) {
        return {
          getJobCounts: async () => { throw new Error('redis connection dropped'); },
          isPaused: async () => false,
        };
      }
      return {
        getJobCounts: async () => ({ waiting: 0 }),
        isPaused: async () => false,
        async close() {},
      };
    },
  });
  const getSnapshot = () => runtime.probe();
  const app = express();
  app.use('/api/admin/queues', adminQueues.INTERNAL.createAdminQueuesRouter({
    authenticateMiddleware: authenticateRole,
    requireAdminMiddleware: requireAdminRole,
    requireSuperAdminMiddleware: requireSuperAdminRole,
    getHealthSnapshot: getSnapshot,
    getBoardStatus: getSnapshot,
    env: { REDIS_URL: 'redis://configured' },
  }));

  const first = await request(app)
    .get('/api/admin/queues/status')
    .set('x-test-role', 'admin');
  const second = await request(app)
    .get('/api/admin/queues/status')
    .set('x-test-role', 'admin');

  assert.equal(first.status, 200);
  assert.equal(first.body.queueBoard.status, 'degraded');
  assert.equal(connections[0].disconnects, 1);
  assert.equal(second.status, 200);
  assert.equal(second.body.queueBoard.status, 'ready');
  assert.equal(queueCreations, 2);
  assert.equal(connections.length, 2);
  await runtime.close();
});

test('Bull Board denies ordinary admins and permits super admins', async () => {
  let boardMounts = 0;
  const boardHandler = (_req, res) => {
    boardMounts += 1;
    res.status(200).json({ board: true });
  };
  const app = express();
  app.use('/api/admin/queues', adminQueues.INTERNAL.createAdminQueuesRouter({
    authenticateMiddleware: authenticateRole,
    requireAdminMiddleware: requireAdminRole,
    requireSuperAdminMiddleware: requireSuperAdminRole,
    getBoardRuntime: () => ({
      serverAdapter: { getRouter: () => boardHandler },
    }),
    env: { REDIS_URL: 'redis://configured' },
  }));

  const denied = await request(app)
    .get('/api/admin/queues/board')
    .set('x-test-role', 'admin');
  assert.equal(denied.status, 403);
  assert.equal(boardMounts, 0);

  const allowed = await request(app)
    .get('/api/admin/queues/board')
    .set('x-test-role', 'super');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.board, true);
  assert.equal(boardMounts, 1);
});
