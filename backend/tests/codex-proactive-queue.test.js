'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const proactiveQueue = require('../src/services/codex/proactive-queue');

afterEach(() => proactiveQueue.__resetForTests());

test('proactive BullMQ scheduler is inert when disabled or Redis is unavailable', async () => {
  assert.equal(await proactiveQueue.startProactiveScheduler({
    env: { CODEX_PROACTIVE_ENABLED: '0', REDIS_URL: 'redis://test' },
    proactive: { tickerEnabled: () => false },
  }), null);
  assert.equal(await proactiveQueue.startProactiveScheduler({
    env: { CODEX_PROACTIVE_ENABLED: '1' },
    proactive: { tickerEnabled: () => true },
  }), null);
});

test('proactive BullMQ scheduler installs one repeatable job and processes cycles plus digest', async () => {
  const calls = [];
  class FakeQueue {
    constructor(name, options) {
      calls.push(['queue', name, options]);
    }
    on() {}
    async upsertJobScheduler(id, repeat, job) {
      calls.push(['scheduler', id, repeat, job]);
    }
    async close() {}
  }
  class FakeWorker {
    constructor(name, handler, options) {
      calls.push(['worker', name, options]);
      this.handler = handler;
    }
    on() {}
    async close() {}
  }
  const connections = [];
  const scheduler = await proactiveQueue.startProactiveScheduler({
    env: {
      CODEX_PROACTIVE_ENABLED: '1',
      CODEX_PROACTIVE_INTERVAL_MS: '60000',
      REDIS_URL: 'redis://test',
    },
    deps: { prisma: { marker: true } },
    QueueImpl: FakeQueue,
    WorkerImpl: FakeWorker,
    createConnection: ({ label }) => {
      const value = { label, async quit() {} };
      connections.push(value);
      return value;
    },
    runtimeOptions: () => ({ skipVersionCheck: true }),
    proactive: {
      tickerEnabled: () => true,
      async tickAll() {
        calls.push(['tick']);
        return [{ action: 'proposed' }];
      },
    },
    digest: {
      async sendDailyDigest() {
        calls.push(['digest']);
        return { action: 'sent' };
      },
    },
  });

  const outcome = await scheduler.worker.handler();
  assert.deepEqual(outcome, {
    results: [{ action: 'proposed' }],
    digest: { action: 'sent' },
  });
  assert.equal(connections.length, 2);
  assert.deepEqual(calls.find((row) => row[0] === 'scheduler').slice(1, 3), [
    'codex-proactive-tick',
    { every: 60000 },
  ]);
});
