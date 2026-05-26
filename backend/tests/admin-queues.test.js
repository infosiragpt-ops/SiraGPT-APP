const test = require('node:test');
const assert = require('node:assert/strict');

const adminQueues = require('../src/routes/admin-queues');

test('admin queue dashboard is disabled cleanly without REDIS_URL', async () => {
  const status = await adminQueues.INTERNAL.buildQueueBoardStatus({
    env: { AGENT_QUEUE_NAME: 'custom-agent-tasks' },
    getHealth: async () => {
      throw new Error('should not connect');
    },
  });

  assert.equal(status.status, 'disabled');
  assert.equal(status.redisUrlConfigured, false);
  assert.equal(status.queue, 'custom-agent-tasks');
});

test('admin queue dashboard reports queue health when Redis is configured', async () => {
  const status = await adminQueues.INTERNAL.buildQueueBoardStatus({
    env: {
      REDIS_URL: 'redis://localhost:6379',
      AGENT_QUEUE_NAME: 'siragpt-agent-tasks',
    },
    getHealth: async () => ({
      counts: {
        waiting: 1,
        active: 0,
        completed: 4,
        failed: 0,
      },
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
    getHealth: async () => {
      throw new Error('redis unavailable');
    },
  });

  assert.equal(status.status, 'degraded');
  assert.match(status.reason, /redis unavailable/);
});

// ── Ratchet 45 — /api/admin/queues/health snapshot ──────────────────

test('queues health snapshot is disabled cleanly without REDIS_URL', async () => {
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: {},
    registry: new Map([['agent-task', () => ({})]]),
  });
  assert.equal(snap.status, 'disabled');
  assert.deepEqual(snap.queues, []);
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
    registry: new Map([['siragpt-agent-tasks', () => fakeQueue]]),
  });
  assert.equal(snap.status, 'ready');
  assert.equal(snap.queues.length, 1);
  const q = snap.queues[0];
  assert.equal(q.name, 'siragpt-agent-tasks');
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
    registry: new Map([['broken-queue', () => failing]]),
  });
  assert.equal(snap.status, 'degraded');
  assert.equal(snap.queues[0].jobs, null);
  assert.equal(snap.queues[0].isPaused, null);
  assert.match(snap.queues[0].lastError, /redis disconnected/);
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
    registry: new Map([['paused-queue', () => paused]]),
  });
  assert.equal(snap.queues[0].isPaused, true);
  assert.equal(snap.queues[0].jobs.paused, 12);
});

test('registerQueue exposes a queue in the default registry for subsequent snapshots', async () => {
  // Reset the shared registry so this test is independent of order.
  adminQueues.INTERNAL._registeredQueues.clear();
  adminQueues.INTERNAL._lastErrorByQueue.clear();
  const calls = [];
  adminQueues.INTERNAL.registerQueue('extra-queue', () => {
    calls.push('built');
    return {
      async getJobCounts() {
        return { waiting: 1, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
      },
      async isPaused() { return false; },
    };
  });
  const snap = await adminQueues.INTERNAL.buildQueuesHealthSnapshot({
    env: { REDIS_URL: 'redis://localhost:6379' },
  });
  assert.ok(snap.queues.some((q) => q.name === 'extra-queue'));
  assert.ok(calls.length >= 1);
  // Tidy up the global registry so it doesn't leak to other tests.
  adminQueues.INTERNAL._registeredQueues.clear();
  adminQueues.INTERNAL._lastErrorByQueue.clear();
});
