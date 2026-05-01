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
