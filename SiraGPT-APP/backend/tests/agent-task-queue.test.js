const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../src/services/agents/agent-task-queue');

test('agent task queue requires REDIS_URL for durable runtime', () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  assert.throws(() => queue.requireRedisUrl(), /REDIS_URL is required/);

  if (previous) process.env.REDIS_URL = previous;
});

test('agent task queue exposes deterministic default name', () => {
  const previous = process.env.AGENT_QUEUE_NAME;
  delete process.env.AGENT_QUEUE_NAME;

  assert.equal(queue.getQueueName(), 'siragpt-agent-tasks');

  if (previous) process.env.AGENT_QUEUE_NAME = previous;
});
