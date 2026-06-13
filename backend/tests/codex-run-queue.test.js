'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const runQueue = require('../src/services/codex/run-queue');

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ['CODEX_QUEUE_NAME', 'CODEX_AGENT_V2', 'REDIS_URL', 'BULLMQ_SKIP_VERSION_CHECK']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test('getQueueName defaults to codex-runs', () => {
  assert.equal(runQueue.getQueueName(), process.env.CODEX_QUEUE_NAME || 'codex-runs');
});

test('getRuntimeOptions skips the version check for Upstash and when forced', () => {
  assert.deepEqual(runQueue.getRuntimeOptions({ redisUrl: 'rediss://x.upstash.io:6379' }), { skipVersionCheck: true });
  assert.deepEqual(runQueue.getRuntimeOptions({ redisUrl: 'redis://localhost:6379' }), {});
  process.env.BULLMQ_SKIP_VERSION_CHECK = '1';
  assert.deepEqual(runQueue.getRuntimeOptions({ redisUrl: 'redis://localhost:6379' }), { skipVersionCheck: true });
});

test('startCodexWorker is a no-op (null) when the flag is off', () => {
  delete process.env.CODEX_AGENT_V2;
  assert.equal(runQueue.startCodexWorker({ env: { CODEX_AGENT_V2: '' } }), null);
});

test('startCodexWorker is a no-op (null) when the flag is on but REDIS_URL is absent', () => {
  delete process.env.REDIS_URL;
  assert.equal(runQueue.startCodexWorker({ env: { CODEX_AGENT_V2: '1' } }), null);
});

test('requireRedisUrl throws when REDIS_URL is missing', () => {
  delete process.env.REDIS_URL;
  assert.throws(() => runQueue.requireRedisUrl(), /REDIS_URL is required/);
});
