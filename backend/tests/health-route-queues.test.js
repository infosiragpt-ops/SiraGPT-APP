'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const request = require('supertest');

const backendPackage = require('../package.json');
const utilityMetrics = require('../src/utils/metrics');
const {
  DEFAULT_QUEUE_IDS,
  JOB_STATES,
  createDefaultQueueRegistry,
  createQueueHealthProbeRuntime,
  createQueueRegistry,
  getQueueMetricsRefreshIntervalMs,
  getQueueProbeTimeoutMs,
  probeQueueRegistry,
} = require('../src/services/queues/queue-registry');
const {
  createHealthRoutes,
  healthRedisConnectionOptions,
} = require('../src/routes/health-routes');

const QUEUE_MODULE_PATHS = [
  '../src/services/agents/agent-task-queue',
  '../src/services/chat-run-queue',
  '../src/services/codex/run-queue',
  '../src/services/document-collection-queue',
  '../src/services/goal-queue',
].map((path) => require.resolve(path));

function fakeQueue({ waiting = 0, completed = 0, paused = false } = {}) {
  return {
    async getJobCounts(...states) {
      return Object.fromEntries(states.map((state) => [
        state,
        state === 'waiting' ? waiting : state === 'completed' ? completed : 0,
      ]));
    },
    async isPaused() {
      return paused;
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function failIfPending(promise, timeoutMs = 500) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`queue probe remained pending after ${timeoutMs}ms`);
    }),
  ]);
}

function buildHealthApp(queueRegistry, overrides = {}) {
  const app = express();
  createHealthRoutes({
    prisma: { $queryRawUnsafe: async () => [] },
    redis: { ping: async () => 'PONG' },
    queueRegistry,
    cacheTtlMs: 0,
    env: {
      REDIS_URL: 'redis://configured-for-contract.test:6379',
      OPENAI_API_KEY: 'test-only',
    },
    ...overrides,
  }).register(app);
  return app;
}

test('canonical backend test script registers all queue health suites', () => {
  assert.equal(backendPackage.scripts.pretest, undefined);
  assert.match(backendPackage.scripts.test, /tests\/health-route-queues\.test\.js/);
  assert.match(backendPackage.scripts.test, /tests\/admin-queues\.test\.js/);
  assert.match(backendPackage.scripts.test, /tests\/admin-queues-legacy\.test\.js/);
});

test('public readiness and full routes pass their injected env to DB probes', async (t) => {
  const previous = process.env.HEALTH_DB_TIMEOUT_MS;
  process.env.HEALTH_DB_TIMEOUT_MS = '300';
  t.after(() => {
    if (previous === undefined) delete process.env.HEALTH_DB_TIMEOUT_MS;
    else process.env.HEALTH_DB_TIMEOUT_MS = previous;
  });
  const app = buildHealthApp(null, {
    prisma: { $queryRawUnsafe: () => new Promise(() => {}) },
    env: {
      HEALTH_DB_TIMEOUT_MS: '100',
      OPENAI_API_KEY: 'test-only',
    },
  });

  for (const path of ['/health/ready', '/health']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 503);
    const database = response.body.checks.find((check) => check.name === 'database');
    const migrations = response.body.checks.find((check) => check.name === 'migrations');
    assert.equal(database.error, 'DATABASE_PROBE_TIMEOUT');
    assert.equal(migrations.error, 'MIGRATIONS_PROBE_TIMEOUT');
  }
});

test('public readiness and full routes pass their injected env to Redis probes', async (t) => {
  const previous = process.env.HEALTH_REDIS_TIMEOUT_MS;
  process.env.HEALTH_REDIS_TIMEOUT_MS = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.HEALTH_REDIS_TIMEOUT_MS;
    else process.env.HEALTH_REDIS_TIMEOUT_MS = previous;
  });
  const app = buildHealthApp(null, {
    redis: {
      ping: () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('late Redis failure')), 180);
      }),
    },
    env: {
      HEALTH_REDIS_TIMEOUT_MS: '1',
      OPENAI_API_KEY: 'test-only',
    },
  });

  for (const path of ['/health/ready', '/health']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 503);
    const redis = response.body.checks.find((check) => check.name === 'redis');
    assert.equal(redis.status, 'unhealthy');
    assert.equal(redis.critical, true);
    assert.equal(redis.error, 'REDIS_PROBE_TIMEOUT');
  }
});

test('public health routes never expose raw database connection values', async () => {
  const databaseUrl = 'postgresql://health-user:health-password@health-db.private:5432/sira';
  const app = buildHealthApp(null, {
    prisma: {
      $queryRawUnsafe: async () => {
        throw new Error(`health-user failed against health-db.private using ${databaseUrl}`);
      },
    },
    env: {
      DATABASE_URL: databaseUrl,
      OPENAI_API_KEY: 'test-only',
    },
  });

  for (const path of ['/health/ready', '/health']) {
    const response = await request(app).get(path);
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /health-user|health-password|health-db\.private|postgresql:\/\//i,
    );
  }
});

test('default registry lists physical queue names without loading producer modules', () => {
  for (const modulePath of QUEUE_MODULE_PATHS) {
    assert.equal(require.cache[modulePath], undefined);
  }

  const registry = createDefaultQueueRegistry({
    env: {
      AGENT_QUEUE_NAME: 'physical-agent',
      CHAT_RUN_QUEUE_NAME: 'physical-chat',
      CODEX_QUEUE_NAME: 'physical-codex',
      DOCUMENT_COLLECTION_QUEUE_NAME: 'physical-documents',
      GOAL_QUEUE_NAME: 'physical-goals',
    },
  });
  const definitions = registry.list();

  assert.deepEqual(definitions.map((definition) => definition.id), DEFAULT_QUEUE_IDS);
  assert.deepEqual(definitions.map((definition) => definition.name), [
    'physical-agent',
    'physical-chat',
    'physical-codex',
    'physical-documents',
    'physical-goals',
  ]);
  assert.ok(definitions.every((definition) => typeof definition.getter === 'function'));
  assert.ok(definitions.every((definition) => definition.critical === false));
  for (const modulePath of QUEUE_MODULE_PATHS) {
    assert.equal(require.cache[modulePath], undefined);
  }
});

test('HEALTH_CRITICAL_QUEUES only marks known comma-separated queue names', () => {
  const registry = createDefaultQueueRegistry({
    env: {
      HEALTH_CRITICAL_QUEUES: ' agent-task,unknown,goal-runs,agent-task ',
    },
  });

  assert.deepEqual(
    registry.list().filter((definition) => definition.critical).map((definition) => definition.id),
    ['agent-task', 'goal-runs'],
  );
});

test('each production-default physical queue failure makes readiness return 503', async () => {
  const criticalQueues = DEFAULT_QUEUE_IDS.join(',');
  for (const failedId of DEFAULT_QUEUE_IDS) {
    const definitions = DEFAULT_QUEUE_IDS.map((id) => ({
      id,
      name: id,
      getter: () => {
        if (id === failedId) throw new Error('queue unavailable');
        return fakeQueue();
      },
    }));
    const env = {
      HEALTH_CRITICAL_QUEUES: criticalQueues,
      REDIS_URL: 'redis://configured-for-contract.test:6379',
      OPENAI_API_KEY: 'test-only',
    };
    const registry = createQueueRegistry({ definitions, env });
    assert.ok(registry.list().every((definition) => definition.critical));

    const response = await request(buildHealthApp(registry, { env })).get('/health/ready');
    assert.equal(response.status, 503, `${failedId} failure must fail readiness`);
    const queue = response.body.checks.find((check) => check.name === 'queue');
    assert.equal(queue.status, 'unhealthy');
    assert.equal(queue.critical, true);
    assert.equal(queue.details.criticalFailures, 1);
  }
});

test('queue probe timeout defaults to 1500ms and clamps positive overrides', () => {
  assert.equal(getQueueProbeTimeoutMs({}), 1500);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '' }), 1500);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '0' }), 1500);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '-5' }), 1500);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1' }), 100);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '425' }), 425);
  assert.equal(getQueueProbeTimeoutMs({ HEALTH_QUEUE_PROBE_TIMEOUT_MS: '20000' }), 10000);
});

test('dedicated operational health Redis options use the bounded ping timeout', () => {
  assert.equal(healthRedisConnectionOptions({}).commandTimeout, 1000);
  assert.equal(
    healthRedisConnectionOptions({ HEALTH_REDIS_TIMEOUT_MS: '1' }).commandTimeout,
    100,
  );
  assert.equal(
    healthRedisConnectionOptions({ HEALTH_REDIS_TIMEOUT_MS: '425' }).commandTimeout,
    425,
  );
  assert.equal(
    healthRedisConnectionOptions({ HEALTH_REDIS_TIMEOUT_MS: '20000' }).commandTimeout,
    10_000,
  );
  assert.equal(
    healthRedisConnectionOptions({ HEALTH_REDIS_TIMEOUT_MS: '425' }).connectTimeout,
    425,
  );
});

test('scheduled queue metric refresh interval is bounded and configurable', () => {
  assert.equal(getQueueMetricsRefreshIntervalMs({}), 30_000);
  assert.equal(getQueueMetricsRefreshIntervalMs({ HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS: '5' }), 1_000);
  assert.equal(getQueueMetricsRefreshIntervalMs({ HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS: '45000' }), 45_000);
  assert.equal(getQueueMetricsRefreshIntervalMs({ HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS: '999999' }), 300_000);
});

test('dedicated health runtime never calls producer getters and uses bounded Redis options', async () => {
  let producerCalls = 0;
  const connectionCalls = [];
  const queueCalls = [];
  const connection = {
    on() {},
    async quit() {},
    disconnect() {},
  };
  const registry = createQueueRegistry({
    definitions: [{
      id: 'agent-task',
      name: 'physical-agent-tasks',
      getter: () => {
        producerCalls += 1;
        throw new Error('producer queue must not be used by health');
      },
    }],
  });
  const runtime = createQueueHealthProbeRuntime({
    registry,
    env: {
      REDIS_URL: 'redis://configured',
      HEALTH_QUEUE_PROBE_TIMEOUT_MS: '425',
    },
    cacheTtlMs: 0,
    createConnection(args) {
      connectionCalls.push(args);
      return connection;
    },
    createQueue(args) {
      queueCalls.push(args);
      return fakeQueue({ waiting: 2 });
    },
  });

  const snapshot = await runtime.probe();

  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.queues[0].name, 'physical-agent-tasks');
  assert.equal(producerCalls, 0);
  assert.equal(connectionCalls.length, 1);
  assert.equal(connectionCalls[0].options.enableOfflineQueue, false);
  assert.equal(connectionCalls[0].options.maxRetriesPerRequest, 1);
  assert.equal(connectionCalls[0].options.connectTimeout, 425);
  assert.equal(connectionCalls[0].options.commandTimeout, 425);
  assert.equal(connectionCalls[0].options.retryStrategy(1), 50);
  assert.equal(connectionCalls[0].options.retryStrategy(2), null);
  assert.equal(queueCalls[0].name, 'physical-agent-tasks');
  assert.equal(queueCalls[0].connection, connection);
  await runtime.close();
});

test('dedicated health runtime coalesces in-flight probes and caches a short result', async () => {
  let countCalls = 0;
  let releaseCounts;
  const countsReady = new Promise((resolve) => {
    releaseCounts = resolve;
  });
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{ name: 'physical-chat', getter: () => { throw new Error('producer'); } }],
    }),
    env: { REDIS_URL: 'redis://configured' },
    cacheTtlMs: 1000,
    createConnection: () => ({ on() {}, disconnect() {}, async quit() {} }),
    createQueue: () => ({
      async getJobCounts() {
        countCalls += 1;
        await countsReady;
        return { waiting: 1 };
      },
      async isPaused() { return false; },
      async close() {},
    }),
  });

  const first = runtime.probe();
  const second = runtime.probe();
  assert.equal(first, second);
  assert.equal(countCalls, 0);
  await delay(0);
  assert.equal(countCalls, 1);
  releaseCounts();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, secondResult);

  const cached = await runtime.probe();
  assert.equal(cached, firstResult);
  assert.equal(countCalls, 1);
  await runtime.close();
});

test('dedicated health timeout disconnects and replaces only its health connection', async () => {
  const connections = [];
  let queueCreations = 0;
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{
        name: 'physical-goals',
        critical: false,
        getter: () => { throw new Error('producer must stay untouched'); },
      }],
    }),
    env: {
      REDIS_URL: 'redis://configured',
      HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1',
    },
    cacheTtlMs: 0,
    createConnection() {
      const connection = {
        disconnected: 0,
        on() {},
        disconnect() { this.disconnected += 1; },
        async quit() {},
      };
      connections.push(connection);
      return connection;
    },
    createQueue() {
      queueCreations += 1;
      if (queueCreations === 1) {
        return { getJobCounts: () => new Promise(() => {}) };
      }
      return {
        getJobCounts: async () => ({ waiting: 0 }),
        isPaused: async () => false,
        async close() {},
      };
    },
  });

  const timedOut = await failIfPending(runtime.probe());
  assert.equal(timedOut.status, 'degraded');
  assert.match(timedOut.queues[0].lastError, /timed out after 100ms/);
  assert.equal(connections[0].disconnected, 1);

  const recovered = await failIfPending(runtime.probe({ bypassCache: true }));
  assert.equal(recovered.status, 'ready');
  assert.equal(queueCreations, 2);
  assert.equal(connections.length, 2);
  await runtime.close();
});

test('dedicated health runtime close releases created queues and connections once', async () => {
  let queueCloses = 0;
  let connectionQuits = 0;
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{ name: 'physical-documents', getter: () => ({}) }],
    }),
    env: { REDIS_URL: 'redis://configured' },
    cacheTtlMs: 0,
    createConnection: () => ({
      on() {},
      disconnect() {},
      async quit() { connectionQuits += 1; },
    }),
    createQueue: () => ({
      getJobCounts: async () => ({}),
      isPaused: async () => false,
      async close() { queueCloses += 1; },
    }),
  });

  await runtime.probe();
  await runtime.close();
  await runtime.close();

  assert.equal(queueCloses, 1);
  assert.equal(connectionQuits, 1);
});

test('dedicated health runtime close prevents a scheduled probe from creating clients', async () => {
  let connectionsCreated = 0;
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{ name: 'physical-codex', getter: () => ({}) }],
    }),
    env: { REDIS_URL: 'redis://configured' },
    cacheTtlMs: 0,
    createConnection: () => {
      connectionsCreated += 1;
      return { on() {}, disconnect() {}, async quit() {} };
    },
    createQueue: () => fakeQueue(),
  });

  const scheduledProbe = runtime.probe();
  await runtime.close();
  await scheduledProbe;

  assert.equal(connectionsCreated, 0);
});

test('dedicated health runtime starts one immediate scheduled refresh and stops its timer', async () => {
  let countCalls = 0;
  const schedules = [];
  const cleared = [];
  const runtime = createQueueHealthProbeRuntime({
    registry: createQueueRegistry({
      definitions: [{ name: 'physical-scheduled', getter: () => ({}) }],
    }),
    env: { REDIS_URL: 'redis://configured' },
    cacheTtlMs: 5_000,
    metricsRefreshIntervalMs: 12_345,
    createConnection: () => ({ on() {}, disconnect() {}, async quit() {} }),
    createQueue: () => ({
      async getJobCounts() {
        countCalls += 1;
        return { waiting: countCalls };
      },
      async isPaused() { return false; },
      async close() {},
    }),
    setIntervalFn(callback, intervalMs) {
      const timer = { callback, intervalMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      schedules.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      cleared.push(timer);
    },
  });

  const first = await runtime.start();
  assert.equal(first.status, 'ready');
  assert.equal(countCalls, 1);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].intervalMs, 12_345);
  assert.equal(schedules[0].unrefCalled, true);

  await schedules[0].callback();
  assert.equal(countCalls, 2, 'scheduled refresh must bypass the readiness cache');
  await runtime.start();
  assert.equal(schedules.length, 1, 'start must be idempotent');

  assert.equal(runtime.stop(), true);
  assert.equal(runtime.stop(), false);
  assert.deepEqual(cleared, [schedules[0]]);
  await runtime.close();
});

test('queue probe is disabled and lists skipped queues without Redis or getter calls', async () => {
  let getterCalls = 0;
  const registry = createQueueRegistry({
    definitions: [
      {
        name: 'optional-one',
        getter: () => {
          getterCalls += 1;
          return fakeQueue();
        },
      },
      {
        name: 'optional-two',
        getter: () => {
          getterCalls += 1;
          return fakeQueue();
        },
      },
    ],
  });

  const snapshot = await probeQueueRegistry({ registry, env: {} });

  assert.equal(snapshot.status, 'disabled');
  assert.match(snapshot.reason, /REDIS_URL/);
  assert.equal(getterCalls, 0);
  assert.deepEqual(snapshot.queues.map((queue) => queue.name), ['optional-one', 'optional-two']);
  assert.deepEqual(snapshot.queues.map((queue) => queue.status), ['skipped', 'skipped']);
  assert.equal(snapshot.queues[0].jobs, null);
  assert.equal(snapshot.queues[0].isPaused, null);
  assert.equal(snapshot.queues[0].lastError, null);
  assert.equal(snapshot.queues[0].critical, false);
});

test('missing Redis makes selected critical physical queues unhealthy and readiness returns 503', async () => {
  let getterCalls = 0;
  const env = {
    HEALTH_CRITICAL_QUEUES: 'critical-one',
    OPENAI_API_KEY: 'test-only',
  };
  const registry = createQueueRegistry({
    env,
    definitions: [
      {
        name: 'critical-one',
        getter: () => {
          getterCalls += 1;
          return fakeQueue();
        },
      },
      {
        name: 'optional-one',
        getter: () => {
          getterCalls += 1;
          return fakeQueue();
        },
      },
    ],
  });

  const snapshot = await probeQueueRegistry({ registry, env });
  assert.equal(snapshot.status, 'unhealthy');
  assert.match(snapshot.reason, /REDIS_URL/);
  assert.equal(getterCalls, 0);
  assert.deepEqual(snapshot.queues.map((queue) => queue.status), ['unhealthy', 'skipped']);
  assert.equal(snapshot.queues[0].critical, true);

  const response = await request(buildHealthApp(registry, { env })).get('/health/ready');
  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'unhealthy');
  const queueCheck = response.body.checks.find((check) => check.name === 'queue');
  assert.equal(queueCheck.status, 'unhealthy');
  assert.equal(queueCheck.critical, true);
  assert.equal(queueCheck.details.criticalFailures, 1);
});

test('queue probe returns counts and ready when every queue succeeds', async () => {
  const registry = createQueueRegistry({
    definitions: [
      { name: 'agent-task', getter: () => fakeQueue({ waiting: 3, completed: 7 }) },
      { name: 'chat-run', getter: () => fakeQueue({ paused: true }) },
    ],
  });

  const snapshot = await probeQueueRegistry({
    registry,
    env: { REDIS_URL: 'redis://configured' },
  });

  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.queues[0].jobs, {
    waiting: 3,
    active: 0,
    completed: 7,
    failed: 0,
    delayed: 0,
    paused: 0,
  });
  assert.equal(snapshot.queues[0].lastError, null);
  assert.equal(snapshot.queues[1].isPaused, true);
});

test('queue probe refreshes low-cardinality job, up, and status gauges', async () => {
  utilityMetrics._reset();
  const counts = {
    waiting: 3,
    active: 1,
    completed: 7,
    failed: 0,
    delayed: 2,
    paused: 0,
  };
  const registry = createQueueRegistry({
    definitions: [{
      name: 'physical-agent-tasks',
      getter: () => ({
        async getJobCounts() {
          return { ...counts };
        },
        async isPaused() {
          return false;
        },
      }),
    }],
  });

  await probeQueueRegistry({
    registry,
    env: { REDIS_URL: 'redis://configured' },
  });

  const jobs = utilityMetrics.registry.get('siragpt_queue_jobs');
  const up = utilityMetrics.registry.get('siragpt_queue_probe_up');
  const status = utilityMetrics.registry.get('siragpt_queue_probe_status');
  assert.deepEqual(jobs.labels, ['queue', 'state']);
  assert.deepEqual(up.labels, ['queue']);
  assert.deepEqual(status.labels, ['status']);
  assert.ok(jobs.maxSeries <= 100);
  assert.ok(up.maxSeries <= 20);
  assert.ok(status.maxSeries <= 10);
  assert.equal(jobs.series.size, JOB_STATES.length);
  assert.equal(jobs.series.get('queue=physical-agent-tasks,state=waiting'), 3);
  assert.equal(jobs.series.get('queue=physical-agent-tasks,state=failed'), 0);
  assert.equal(up.series.get('queue=physical-agent-tasks'), 1);
  assert.equal(status.series.get('status=ready'), 1);

  counts.waiting = 1;
  counts.failed = 4;
  await probeQueueRegistry({
    registry,
    env: { REDIS_URL: 'redis://configured' },
  });

  assert.equal(jobs.series.size, JOB_STATES.length);
  assert.equal(jobs.series.get('queue=physical-agent-tasks,state=waiting'), 1);
  assert.equal(jobs.series.get('queue=physical-agent-tasks,state=failed'), 4);
});

test('queue probe retains last-success timestamps and advances staleness after failures', () => {
  utilityMetrics._reset();
  const ready = {
    status: 'ready',
    queues: [{
      name: 'physical-agent-tasks',
      status: 'ready',
      jobs: Object.fromEntries(JOB_STATES.map((state) => [state, 0])),
    }],
  };
  const failed = {
    status: 'degraded',
    queues: [{
      name: 'physical-agent-tasks',
      status: 'degraded',
      jobs: null,
    }],
  };

  utilityMetrics.refreshQueueMetrics(ready, { nowMs: 100_000 });
  const lastSuccess = utilityMetrics.registry.get(
    'siragpt_queue_probe_last_success_timestamp_seconds',
  );
  const staleness = utilityMetrics.registry.get('siragpt_queue_probe_staleness_seconds');
  assert.deepEqual(lastSuccess.labels, ['queue']);
  assert.deepEqual(staleness.labels, ['queue']);
  assert.equal(lastSuccess.series.get('queue=physical-agent-tasks'), 100);
  assert.equal(staleness.series.get('queue=physical-agent-tasks'), 0);

  utilityMetrics.refreshQueueMetrics(failed, { nowMs: 130_000 });
  assert.equal(
    lastSuccess.series.get('queue=physical-agent-tasks'),
    100,
    'a failed observation must not erase the last known success',
  );
  assert.equal(staleness.series.get('queue=physical-agent-tasks'), 30);

  utilityMetrics.refreshQueueStalenessMetrics(145_000);
  assert.equal(staleness.series.get('queue=physical-agent-tasks'), 45);
});

test('queue probe clears stale job gauges and never exports probe errors', async () => {
  utilityMetrics._reset();
  const sensitiveError = 'redis auth failed for redis://user:secret@private.example';
  let shouldFail = false;
  const registry = createQueueRegistry({
    definitions: [{
      name: 'physical-chat-runs',
      getter: () => ({
        async getJobCounts() {
          if (shouldFail) throw new Error(sensitiveError);
          return { waiting: 9, failed: 2 };
        },
        async isPaused() {
          return false;
        },
      }),
    }],
  });

  await probeQueueRegistry({
    registry,
    env: { REDIS_URL: 'redis://configured' },
  });
  shouldFail = true;
  const snapshot = await probeQueueRegistry({
    registry,
    env: { REDIS_URL: 'redis://configured' },
  });

  assert.equal(snapshot.status, 'degraded');
  assert.match(snapshot.queues[0].lastError, /redis auth failed/);
  assert.equal(utilityMetrics.registry.get('siragpt_queue_jobs').series.size, 0);
  assert.equal(
    utilityMetrics.registry
      .get('siragpt_queue_probe_up')
      .series
      .get('queue=physical-chat-runs'),
    0,
  );
  assert.equal(
    utilityMetrics.registry
      .get('siragpt_queue_probe_status')
      .series
      .get('status=degraded'),
    1,
  );
  assert.doesNotMatch(utilityMetrics.renderText(), /secret|private\.example|auth failed/i);
});

test('queue probe degrades on a noncritical failure and is unhealthy on a critical failure', async () => {
  const failingGetter = () => ({
    async getJobCounts() {
      throw new Error('redis disconnected');
    },
  });

  const optionalSnapshot = await probeQueueRegistry({
    registry: createQueueRegistry({
      definitions: [{ name: 'chat-run', getter: failingGetter, critical: false }],
    }),
    env: { REDIS_URL: 'redis://configured' },
  });
  assert.equal(optionalSnapshot.status, 'degraded');
  assert.equal(optionalSnapshot.queues[0].status, 'degraded');
  assert.match(optionalSnapshot.queues[0].lastError, /redis disconnected/);

  const criticalSnapshot = await probeQueueRegistry({
    registry: createQueueRegistry({
      definitions: [{ name: 'agent-task', getter: failingGetter, critical: true }],
    }),
    env: { REDIS_URL: 'redis://configured' },
  });
  assert.equal(criticalSnapshot.status, 'unhealthy');
  assert.equal(criticalSnapshot.queues[0].status, 'unhealthy');
  assert.equal(criticalSnapshot.queues[0].critical, true);
});

test('queue probe times out never-settling getJobCounts and isPaused operations', async () => {
  const cases = [
    {
      name: 'getJobCounts',
      queue: {
        getJobCounts: () => new Promise(() => {}),
      },
    },
    {
      name: 'isPaused',
      queue: {
        getJobCounts: async () => ({}),
        isPaused: () => new Promise(() => {}),
      },
    },
  ];

  for (const testCase of cases) {
    const startedAt = Date.now();
    const snapshot = await failIfPending(probeQueueRegistry({
      registry: createQueueRegistry({
        definitions: [{
          name: testCase.name,
          critical: false,
          getter: () => testCase.queue,
        }],
      }),
      env: {
        REDIS_URL: 'redis://configured',
        HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1',
      },
    }));

    assert.equal(snapshot.status, 'degraded');
    assert.equal(snapshot.queues[0].status, 'degraded');
    assert.match(snapshot.queues[0].lastError, /timed out after 100ms/);
    assert.ok(Date.now() - startedAt < 500, `${testCase.name} probe should be bounded`);
  }
});

test('queue probe timeout is unhealthy for a critical queue', async () => {
  const snapshot = await failIfPending(probeQueueRegistry({
    registry: createQueueRegistry({
      definitions: [{
        name: 'agent-task',
        critical: true,
        getter: () => ({
          getJobCounts: () => new Promise(() => {}),
        }),
      }],
    }),
    env: {
      REDIS_URL: 'redis://configured',
      HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1',
    },
  }));

  assert.equal(snapshot.status, 'unhealthy');
  assert.equal(snapshot.queues[0].status, 'unhealthy');
  assert.match(snapshot.queues[0].lastError, /timed out after 100ms/);
});

test('dedicated health runtime absorbs late getJobCounts and isPaused rejections after reset', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    const cases = [
      {
        name: 'late-counts',
        queue: {
          getJobCounts: () => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late counts rejection')), 130);
          }),
        },
      },
      {
        name: 'late-paused',
        queue: {
          getJobCounts: async () => ({}),
          isPaused: () => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late paused rejection')), 130);
          }),
        },
      },
    ];

    for (const testCase of cases) {
      let disconnects = 0;
      const runtime = createQueueHealthProbeRuntime({
        registry: createQueueRegistry({
          definitions: [{
            name: testCase.name,
            getter: () => { throw new Error('producer queue must not be used'); },
          }],
        }),
        env: {
          REDIS_URL: 'redis://configured',
          HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1',
        },
        cacheTtlMs: 0,
        createConnection: () => ({
          on() {},
          disconnect() { disconnects += 1; },
          async quit() {},
        }),
        createQueue: () => testCase.queue,
      });
      const snapshot = await runtime.probe();
      assert.equal(snapshot.status, 'degraded');
      assert.match(snapshot.queues[0].lastError, /timed out after 100ms/);
      assert.equal(disconnects, 1);
      await delay(80);
      await runtime.close();
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
});

test('operational queue check degrades without 503 for a noncritical queue failure', async () => {
  const response = await request(buildHealthApp(null, {
    queueProbe: async () => ({
      status: 'degraded',
      queues: [
        {
          name: 'physical-agent',
          critical: true,
          status: 'ready',
          jobs: { waiting: 4 },
          lastError: null,
        },
        {
          name: 'physical-chat',
          critical: false,
          status: 'degraded',
          jobs: null,
          lastError: 'optional queue unavailable',
        },
      ],
    }),
  })).get('/health/ready');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'degraded');
  const queueCheck = response.body.checks.find((check) => check.name === 'queue');
  assert.ok(queueCheck);
  assert.equal(queueCheck.critical, false);
  assert.equal(queueCheck.status, 'degraded');
  assert.equal(queueCheck.details.status, 'degraded');
  assert.equal(queueCheck.details.total, 2);
  assert.equal(queueCheck.details.criticalFailures, 0);
  assert.equal(queueCheck.details.queues, undefined);
  assert.equal(queueCheck.error, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /waiting|lastError|optional queue unavailable/);
});

test('operational queue check returns 503 only when a critical queue fails', async () => {
  const registry = createQueueRegistry({
    definitions: [{
      name: 'agent-task',
      critical: true,
      getter: () => ({
        async getJobCounts() {
          throw new Error('critical queue unavailable');
        },
      }),
    }],
  });

  const response = await request(buildHealthApp(registry)).get('/health/ready');

  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'unhealthy');
  const queueCheck = response.body.checks.find((check) => check.name === 'queue');
  assert.ok(queueCheck);
  assert.equal(queueCheck.critical, true);
  assert.equal(queueCheck.status, 'unhealthy');
  assert.equal(queueCheck.details.status, 'unhealthy');
  assert.equal(queueCheck.details.criticalFailures, 1);
  assert.equal(queueCheck.details.queues, undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /critical queue unavailable|lastError|jobs/);
});

test('createHealthRoutes coalesces concurrent first refreshes and exposes close lifecycle', async () => {
  let fetchCalls = 0;
  let release;
  let queueProbeCloses = 0;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const routes = createHealthRoutes({
    cacheTtlMs: 1000,
    queueHealthProbe: {
      probe: async () => ({ status: 'ready', queues: [] }),
      async close() { queueProbeCloses += 1; },
    },
    redis: null,
    env: {},
  });
  const fetcher = async () => {
    fetchCalls += 1;
    await ready;
    return { status: 'healthy' };
  };

  const first = routes.getCachedOrFresh('first-refresh', fetcher);
  const second = routes.getCachedOrFresh('first-refresh', fetcher);
  const callsBeforeRelease = fetchCalls;
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'healthy' },
    { status: 'healthy' },
  ]);
  assert.equal(callsBeforeRelease, 1);
  assert.equal(fetchCalls, 1);

  await routes.close();
  await routes.close();
  assert.equal(queueProbeCloses, 1);
});

test('production shutdown closes queue health runtime and chat-run producer queue', () => {
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

  assert.match(source, /const\s+\{\s*closeChatRunQueue\s*\}\s*=\s*require\('\.\/src\/services\/chat-run-queue'\)/);
  assert.match(source, /bullmq_workers_close[\s\S]*closeChatRunQueue\(\)/);
  assert.match(
    source,
    /shutdownRegistry\.register\(\s*'queue_health_probe_close',\s*\(\)\s*=>\s*healthRoutes\.closeQueueHealthProbe\(\)/,
  );
});
