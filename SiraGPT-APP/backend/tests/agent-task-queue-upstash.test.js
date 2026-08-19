const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getBullMQRuntimeOptions,
  shouldSkipBullMQVersionCheck,
} = require('../src/services/agents/agent-task-queue');

test('enables BullMQ skipVersionCheck for Upstash Redis URLs', () => {
  const redisUrl = 'rediss://default:secret@kind-heron-12345.upstash.io:6379';

  assert.equal(shouldSkipBullMQVersionCheck({ redisUrl }), true);
  assert.deepEqual(getBullMQRuntimeOptions({ redisUrl }), { skipVersionCheck: true });
});

test('keeps BullMQ version/eviction checks for non-Upstash Redis by default', () => {
  const redisUrl = 'redis://localhost:6379/0';

  assert.equal(shouldSkipBullMQVersionCheck({ redisUrl }), false);
  assert.deepEqual(getBullMQRuntimeOptions({ redisUrl }), {});
});

test('allows explicit BullMQ version-check override for managed Redis providers', () => {
  const redisUrl = 'redis://cache.example.com:6379/0';

  assert.equal(shouldSkipBullMQVersionCheck({ redisUrl, env: { BULLMQ_SKIP_VERSION_CHECK: 'true' } }), true);
  assert.deepEqual(getBullMQRuntimeOptions({ redisUrl, env: { BULLMQ_SKIP_VERSION_CHECK: '1' } }), { skipVersionCheck: true });
});
