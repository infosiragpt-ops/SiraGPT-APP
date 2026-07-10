'use strict';

const {
  after,
  before,
  beforeEach,
  describe,
  test,
} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

const PHYSICAL_NAMES = [
  'siragpt-agent-tasks',
  'siragpt-chat-runs',
  'codex-runs',
  'siragpt-document-collections',
  'siragpt-goal-runs',
];

function authenticateRole(req, _res, next) {
  const role = req.headers['x-test-role'];
  req.user = {
    id: `${role || 'user'}-1`,
    email: `${role || 'user'}@example.com`,
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

function readySnapshot() {
  return {
    status: 'ready',
    queues: PHYSICAL_NAMES.map((name, index) => ({
      name,
      critical: false,
      status: 'ready',
      jobs: {
        waiting: index,
        active: 0,
        completed: 2,
        failed: 0,
        delayed: 0,
        paused: 0,
      },
      isPaused: false,
      lastError: null,
    })),
  };
}

describe('legacy /api/admin/queues HTTP compatibility', () => {
  let app;
  let snapshot;
  let probeCalls;
  let producerGetterCalls;
  let retried;
  let removed;
  let restoreModules;
  let originalRedisUrl;

  before(() => {
    originalRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://configured';
    snapshot = readySnapshot();
    probeCalls = 0;
    producerGetterCalls = 0;
    retried = 0;
    removed = 0;

    const restores = [];
    restores.push(mockResolvedModule(require.resolve('../src/middleware/auth'), {
      authenticateToken: authenticateRole,
      requireAdmin: requireAdminRole,
      requireSuperAdmin: requireSuperAdminRole,
    }));
    restores.push(mockResolvedModule(require.resolve('../src/services/queues/queue-registry'), {
      defaultQueueHealthProbe: {
        async probe() {
          probeCalls += 1;
          return snapshot;
        },
      },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/services/agents/agent-task-queue'), {
      getQueueName: () => 'siragpt-agent-tasks',
      getQueueHealth: async () => {
        throw new Error('legacy producer health must not be used');
      },
      getAgentTaskQueue: () => {
        producerGetterCalls += 1;
        return {
          async getFailed() {
            return [
              { async retry() { retried += 1; } },
              { async retry() { throw new Error('not retryable'); } },
            ];
          },
          async getJob(id) {
            if (id !== 'job-1') return null;
            return { async remove() { removed += 1; } };
          },
        };
      },
    }));
    restores.push(mockResolvedModule(require.resolve('../src/utils/audit-log'), {
      writeAuditLog: async () => {},
    }));
    restoreModules = () => {
      for (const restore of restores.reverse()) restore();
    };

    delete require.cache[require.resolve('../src/routes/admin')];
    const adminRoutes = require('../src/routes/admin');
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  beforeEach(() => {
    snapshot = readySnapshot();
    probeCalls = 0;
    producerGetterCalls = 0;
    retried = 0;
    removed = 0;
  });

  after(() => {
    delete require.cache[require.resolve('../src/routes/admin')];
    restoreModules?.();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  test('GET /queues denies ordinary admins before probing queue details', async () => {
    const response = await request(app)
      .get('/api/admin/queues')
      .set('x-test-role', 'admin');

    assert.equal(response.status, 403);
    assert.equal(probeCalls, 0);
    assert.equal(producerGetterCalls, 0);
  });

  test('GET /queues returns all five shared physical snapshots with counts compatibility', async () => {
    const response = await request(app)
      .get('/api/admin/queues')
      .set('x-test-role', 'super');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ready');
    assert.deepEqual(response.body.queues.map((queue) => queue.name), PHYSICAL_NAMES);
    assert.deepEqual(response.body.queues[1].counts, response.body.queues[1].jobs);
    assert.equal(probeCalls, 1);
    assert.equal(producerGetterCalls, 0);
  });

  test('GET /queues preserves disabled 503 while listing all skipped queues', async () => {
    snapshot = {
      status: 'disabled',
      reason: 'REDIS_URL is not configured',
      queues: PHYSICAL_NAMES.map((name) => ({
        name,
        status: 'skipped',
        jobs: null,
        isPaused: null,
        lastError: null,
      })),
    };

    const response = await request(app)
      .get('/api/admin/queues')
      .set('x-test-role', 'super');

    assert.equal(response.status, 503);
    assert.match(response.body.error, /disabled/i);
    assert.equal(response.body.queues.length, 5);
    assert.ok(response.body.queues.every((queue) => queue.counts === null));
  });

  test('retry/delete stay super-admin-only and agent-task-only', async () => {
    const deniedRetry = await request(app)
      .post('/api/admin/queues/siragpt-agent-tasks/retry-failed')
      .set('x-test-role', 'admin');
    const deniedDelete = await request(app)
      .delete('/api/admin/queues/siragpt-agent-tasks/job/job-1')
      .set('x-test-role', 'admin');
    assert.equal(deniedRetry.status, 403);
    assert.equal(deniedDelete.status, 403);

    const wrongQueue = await request(app)
      .post('/api/admin/queues/siragpt-chat-runs/retry-failed')
      .set('x-test-role', 'super');
    assert.equal(wrongQueue.status, 404);

    const retry = await request(app)
      .post('/api/admin/queues/siragpt-agent-tasks/retry-failed')
      .set('x-test-role', 'super');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.retried, 1);
    assert.equal(retry.body.totalFailed, 2);
    assert.equal(retried, 1);

    const remove = await request(app)
      .delete('/api/admin/queues/siragpt-agent-tasks/job/job-1')
      .set('x-test-role', 'super');
    assert.equal(remove.status, 200);
    assert.equal(remove.body.removed, 'job-1');
    assert.equal(removed, 1);
    assert.ok(producerGetterCalls >= 2);
  });
});
