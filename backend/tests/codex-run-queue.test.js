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

test('enqueueCodexRun forwards an explicit jobId to BullMQ in every call shape', async () => {
  // Contract regression: boot-recovery passes jobId in the FIRST argument;
  // the old signature only read opts.jobId, silently discarding it — resumed
  // runs re-enqueued with jobId===runId, a BullMQ no-op while the dead job
  // record lingered, so they sat 'queued' forever. Exercise the REAL body.
  const adds = [];
  runQueue.__setQueueForTests({
    add: async (name, data, opts) => { adds.push({ name, data, opts }); return { id: opts.jobId }; },
  });
  try {
    await runQueue.enqueueCodexRun({ runId: 'r1', jobId: 'r1:r1' }); // boot-recovery resume shape
    await runQueue.enqueueCodexRun({ runId: 'r1' }, { jobId: 'r1:rq5' }); // opts shape
    await runQueue.enqueueCodexRun({ runId: 'r1' }); // default: idempotent on runId
    assert.deepEqual(adds.map((a) => a.opts.jobId), ['r1:r1', 'r1:rq5', 'r1']);
    assert.ok(adds.every((a) => a.name === 'codex-run' && a.data.runId === 'r1'));
  } finally {
    runQueue.__setQueueForTests(null);
  }
});
