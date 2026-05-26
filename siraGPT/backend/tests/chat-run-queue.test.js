'use strict';

/**
 * Sprint 3: contract tests for chat-run-queue.js + chat-run-worker.js.
 *
 * We don't spin up Redis or BullMQ here. Instead we verify the surface
 * the modules expose:
 *   - queue name comes from CHAT_RUN_QUEUE_NAME, default
 *     `siragpt-chat-runs`
 *   - concurrency parsing is bounded (1..64)
 *   - enqueueChatRun validates runId
 *   - the Upstash maxmemory advisory check picks the right hosts
 *   - the dormant worker processor returns the skipped sentinel
 *
 * Live Redis-dependent paths (Queue.add, Worker boot) are exercised in
 * the e2e suite once Sprint 4 wires the route.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

const queueMod = require('../src/services/chat-run-queue');
const workerMod = require('../src/services/chat-run-worker');

describe('chat-run-queue: surface', () => {
  beforeEach(() => {
    delete process.env.CHAT_RUN_QUEUE_NAME;
  });

  it('default queue name is siragpt-chat-runs', () => {
    assert.equal(queueMod.getQueueName(), 'siragpt-chat-runs');
  });

  it('env override sets queue name', () => {
    process.env.CHAT_RUN_QUEUE_NAME = 'q-test';
    assert.equal(queueMod.getQueueName(), 'q-test');
    delete process.env.CHAT_RUN_QUEUE_NAME;
  });

  it('enqueueChatRun rejects payloads without runId', async () => {
    await assert.rejects(
      () => queueMod.enqueueChatRun({}),
      /runId is required/,
    );
    await assert.rejects(
      () => queueMod.enqueueChatRun({ runId: '' }),
      /runId is required/,
    );
  });

  it('Upstash detection returns true for *.upstash.io hosts', () => {
    const { shouldSkipBullMQVersionCheck } = queueMod._internals;
    assert.equal(
      shouldSkipBullMQVersionCheck({
        redisUrl: 'rediss://default:pw@us1-modest-bug.upstash.io:6379',
        env: {},
      }),
      true,
    );
  });

  it('Upstash detection returns false for non-upstash hosts', () => {
    const { shouldSkipBullMQVersionCheck } = queueMod._internals;
    assert.equal(
      shouldSkipBullMQVersionCheck({
        redisUrl: 'redis://localhost:6379',
        env: {},
      }),
      false,
    );
  });

  it('Upstash detection honours BULLMQ_SKIP_VERSION_CHECK truthy values', () => {
    const { shouldSkipBullMQVersionCheck } = queueMod._internals;
    for (const truthy of ['1', 'true', 'YES', 'on']) {
      assert.equal(
        shouldSkipBullMQVersionCheck({ redisUrl: 'redis://localhost', env: { BULLMQ_SKIP_VERSION_CHECK: truthy } }),
        true,
        `expected ${truthy} to enable skipping`,
      );
    }
  });

  it('Upstash detection ignores BULLMQ_SKIP_VERSION_CHECK falsy values', () => {
    const { shouldSkipBullMQVersionCheck } = queueMod._internals;
    for (const falsy of ['', '0', 'false', 'off', undefined]) {
      assert.equal(
        shouldSkipBullMQVersionCheck({ redisUrl: 'redis://localhost', env: { BULLMQ_SKIP_VERSION_CHECK: falsy } }),
        false,
        `expected ${falsy} not to enable skipping`,
      );
    }
  });

  it('getBullMQRuntimeOptions returns skip flag only when the env or host says so', () => {
    const { getBullMQRuntimeOptions } = queueMod._internals;
    assert.deepEqual(getBullMQRuntimeOptions({ redisUrl: 'redis://localhost', env: {} }), {});
    assert.deepEqual(
      getBullMQRuntimeOptions({ redisUrl: 'rediss://x.upstash.io', env: {} }),
      { skipVersionCheck: true },
    );
  });

  it('requireRedisUrl throws when REDIS_URL is missing', () => {
    const { requireRedisUrl } = queueMod._internals;
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    assert.throws(() => requireRedisUrl(), /REDIS_URL is required/);
    if (saved) process.env.REDIS_URL = saved;
  });
});

describe('chat-run-worker: surface', () => {
  beforeEach(() => {
    delete process.env.CHAT_RUN_WORKER_CONCURRENCY;
  });

  it('default queue name matches the queue module', () => {
    assert.equal(workerMod.getQueueName(), queueMod.getQueueName());
  });

  it('default concurrency is 4', () => {
    assert.equal(workerMod.getConcurrency(), 4);
  });

  it('parses CHAT_RUN_WORKER_CONCURRENCY when finite + positive', () => {
    process.env.CHAT_RUN_WORKER_CONCURRENCY = '12';
    assert.equal(workerMod.getConcurrency(), 12);
  });

  it('clamps absurdly large concurrency at 64', () => {
    process.env.CHAT_RUN_WORKER_CONCURRENCY = '10000';
    assert.equal(workerMod.getConcurrency(), 64);
  });

  it('falls back to 4 on non-numeric / zero / negative', () => {
    process.env.CHAT_RUN_WORKER_CONCURRENCY = 'banana';
    assert.equal(workerMod.getConcurrency(), 4);
    process.env.CHAT_RUN_WORKER_CONCURRENCY = '0';
    assert.equal(workerMod.getConcurrency(), 4);
    process.env.CHAT_RUN_WORKER_CONCURRENCY = '-2';
    assert.equal(workerMod.getConcurrency(), 4);
  });

  it('dormant processor returns the Sprint 3 skipped sentinel', async () => {
    const r = await workerMod.runChatJob({ id: 'job_1', data: { runId: 'run_1' } });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /not yet implemented/);
  });
});
