'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const goalQueue = require('../src/services/goal-queue');
const goalEvents = require('../src/services/goal-events');
const goalWorker = require('../src/services/goal-worker');
const goalsRoutes = require('../src/routes/goals');

test('goal queue requires REDIS_URL for durable runtime', () => {
  const previous = process.env.REDIS_URL;
  delete process.env.REDIS_URL;

  assert.throws(() => goalQueue.requireRedisUrl(), /REDIS_URL is required/);

  if (previous) process.env.REDIS_URL = previous;
});

test('goal queue exposes deterministic default name', () => {
  const previous = process.env.GOAL_QUEUE_NAME;
  delete process.env.GOAL_QUEUE_NAME;

  assert.equal(goalQueue.getQueueName(), 'siragpt-goal-runs');

  if (previous) process.env.GOAL_QUEUE_NAME = previous;
});

test('goal queue honours GOAL_QUEUE_NAME env override', () => {
  const previous = process.env.GOAL_QUEUE_NAME;
  process.env.GOAL_QUEUE_NAME = 'siragpt-goal-runs-custom';

  assert.equal(goalQueue.getQueueName(), 'siragpt-goal-runs-custom');

  if (previous === undefined) delete process.env.GOAL_QUEUE_NAME;
  else process.env.GOAL_QUEUE_NAME = previous;
});

test('shouldSkipBullMQVersionCheck detects Upstash hostnames correctly', () => {
  assert.equal(
    goalQueue.shouldSkipBullMQVersionCheck({ redisUrl: 'rediss://default:secret@kind-heron-12345.upstash.io:6379' }),
    true,
    'matches *.upstash.io',
  );
  assert.equal(
    goalQueue.shouldSkipBullMQVersionCheck({ redisUrl: 'rediss://default:secret@upstash.io:6379' }),
    true,
    'matches bare upstash.io',
  );
  assert.equal(
    goalQueue.shouldSkipBullMQVersionCheck({ redisUrl: 'redis://localhost:6379/0' }),
    false,
    'rejects localhost',
  );
  assert.equal(
    goalQueue.shouldSkipBullMQVersionCheck({ redisUrl: 'redis://upstash.io.evilcorp.example:6379' }),
    false,
    'rejects phishy hostnames pretending to be upstash',
  );
});

test('getBullMQRuntimeOptions returns skipVersionCheck only for Upstash', () => {
  assert.deepEqual(
    goalQueue.getBullMQRuntimeOptions({ redisUrl: 'rediss://default:secret@x.upstash.io:6379' }),
    { skipVersionCheck: true },
  );
  assert.deepEqual(
    goalQueue.getBullMQRuntimeOptions({ redisUrl: 'redis://localhost:6379' }),
    {},
  );
  assert.deepEqual(
    goalQueue.getBullMQRuntimeOptions({ redisUrl: 'redis://cache.example.com:6379', env: { BULLMQ_SKIP_VERSION_CHECK: '1' } }),
    { skipVersionCheck: true },
  );
});

test('enqueueGoalRun rejects missing goalRunId', async () => {
  await assert.rejects(() => goalQueue.enqueueGoalRun({}), /goalRunId is required/);
});

test('routes/goals exports an express router', () => {
  const router = goalsRoutes;
  assert.equal(typeof router, 'function', 'router is a callable middleware');
  assert.equal(typeof router.use, 'function', 'router has .use');
  assert.equal(typeof router.get, 'function', 'router has .get');
  assert.equal(typeof router.post, 'function', 'router has .post');
});

test('serializeRun returns the public projection (no userId/jobId)', () => {
  const { serializeRun } = goalsRoutes._internal;
  const projected = serializeRun({
    id: 'goal_1',
    userId: 'user_1',
    chatId: 'chat_1',
    jobId: 'job_1',
    status: 'running',
    prompt: 'go!',
    depth: 'standard',
    agentKind: 'research',
    phase: 'browse',
    papersCount: 3,
    findingsCount: 7,
    pagesCount: 2,
    finalReport: null,
    error: null,
    cancelReason: null,
    createdAt: new Date('2026-05-24T11:00:00Z'),
    startedAt: new Date('2026-05-24T11:00:01Z'),
    updatedAt: new Date('2026-05-24T11:01:00Z'),
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
  });
  assert.equal(projected.id, 'goal_1');
  assert.equal(projected.chatId, 'chat_1');
  assert.equal(projected.status, 'running');
  assert.equal(projected.prompt, 'go!');
  assert.equal(projected.depth, 'standard');
  assert.equal(projected.agentKind, 'research');
  assert.equal(projected.phase, 'browse');
  assert.equal(projected.papersCount, 3);
  assert.equal(projected.findingsCount, 7);
  assert.equal(projected.pagesCount, 2);
  assert.equal(projected.finalReport, null);
  assert.equal(projected.error, null);
  assert.equal(projected.cancelReason, null);
  assert.ok(projected.createdAt);
  assert.ok(projected.startedAt);
  assert.ok(projected.updatedAt);
  assert.equal(projected.userId, undefined, 'userId must be stripped');
  assert.equal(projected.jobId, undefined, 'jobId must be stripped');
});

test('serializeRun returns null for null/undefined input', () => {
  const { serializeRun } = goalsRoutes._internal;
  assert.equal(serializeRun(null), null);
  assert.equal(serializeRun(undefined), null);
});

test('goal-worker exports processGoalJob, startGoalWorker, closeGoalWorker', () => {
  assert.equal(typeof goalWorker.processGoalJob, 'function');
  assert.equal(typeof goalWorker.startGoalWorker, 'function');
  assert.equal(typeof goalWorker.closeGoalWorker, 'function');
});

test('goal-events module exports appendEvent, listEventsSince, markCancelRequested', () => {
  assert.equal(typeof goalEvents.appendEvent, 'function');
  assert.equal(typeof goalEvents.listEventsSince, 'function');
  assert.equal(typeof goalEvents.markCancelRequested, 'function');
});
