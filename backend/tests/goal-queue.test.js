'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const goalQueue = require('../src/services/goal-queue');
const goalEvents = require('../src/services/goal-events');
const goalWorker = require('../src/services/goal-worker');
const goalsRoutes = require('../src/routes/goals');
const goalRecovery = require('../src/services/goal-boot-recovery');
const goalCleanup = require('../src/services/goal-cleanup');

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

// ── goal-boot-recovery ─────────────────────────────────────────────
test('goal-boot-recovery exports recoverGoalRunsAfterBoot + stopGoalRecovery', () => {
  assert.equal(typeof goalRecovery.recoverGoalRunsAfterBoot, 'function');
  assert.equal(typeof goalRecovery.stopGoalRecovery, 'function');
  assert.equal(typeof goalRecovery.sweepOnce, 'function');
  assert.equal(typeof goalRecovery.readConfig, 'function');
  assert.equal(typeof goalRecovery.listStuckQueued, 'function');
  assert.equal(typeof goalRecovery.listZombieRunning, 'function');
});

test('stopGoalRecovery is callable when no interval is running', () => {
  // First call: no-op when nothing is running.
  assert.doesNotThrow(() => goalRecovery.stopGoalRecovery());
  // Idempotent — calling again must still be safe.
  assert.doesNotThrow(() => goalRecovery.stopGoalRecovery());
});

test('readConfig defaults: 5 min re-enqueue, 30 min stall, 5 min scan interval', () => {
  const previous = {
    re: process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS,
    stall: process.env.GOAL_RECOVERY_STALL_AFTER_MS,
    scan: process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS,
  };
  delete process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS;
  delete process.env.GOAL_RECOVERY_STALL_AFTER_MS;
  delete process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS;

  const cfg = goalRecovery.readConfig();
  assert.equal(cfg.reenqueueAfterMs, 300_000, 'default reenqueue = 5 minutes');
  assert.equal(cfg.stallAfterMs, 1_800_000, 'default stall = 30 minutes');
  assert.equal(cfg.scanIntervalMs, 300_000, 'default scan interval = 5 minutes');

  // Module-level constants match too.
  assert.equal(goalRecovery.DEFAULT_REENQUEUE_AFTER_MS, 300_000);
  assert.equal(goalRecovery.DEFAULT_STALL_AFTER_MS, 1_800_000);
  assert.equal(goalRecovery.DEFAULT_SCAN_INTERVAL_MS, 300_000);

  if (previous.re !== undefined) process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS = previous.re;
  if (previous.stall !== undefined) process.env.GOAL_RECOVERY_STALL_AFTER_MS = previous.stall;
  if (previous.scan !== undefined) process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS = previous.scan;
});

test('readConfig honours env overrides', () => {
  const previous = {
    re: process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS,
    stall: process.env.GOAL_RECOVERY_STALL_AFTER_MS,
    scan: process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS,
  };
  process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS = '1000';
  process.env.GOAL_RECOVERY_STALL_AFTER_MS = '2000';
  process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS = '3000';

  const cfg = goalRecovery.readConfig();
  assert.equal(cfg.reenqueueAfterMs, 1000);
  assert.equal(cfg.stallAfterMs, 2000);
  assert.equal(cfg.scanIntervalMs, 3000);

  if (previous.re === undefined) delete process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS;
  else process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS = previous.re;
  if (previous.stall === undefined) delete process.env.GOAL_RECOVERY_STALL_AFTER_MS;
  else process.env.GOAL_RECOVERY_STALL_AFTER_MS = previous.stall;
  if (previous.scan === undefined) delete process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS;
  else process.env.GOAL_RECOVERY_SCAN_INTERVAL_MS = previous.scan;
});

test('readConfig falls back to defaults on invalid env values', () => {
  const previous = process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS;
  process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS = 'not-a-number';
  const cfg = goalRecovery.readConfig();
  assert.equal(cfg.reenqueueAfterMs, 300_000, 'falls back to default on garbage');
  if (previous === undefined) delete process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS;
  else process.env.GOAL_RECOVERY_REENQUEUE_AFTER_MS = previous;
});

test('recoverGoalRunsAfterBoot returns zeroed summary when prisma is unavailable', async () => {
  // The module lazy-requires `../config/database` and caches the result.
  // In the test runner the require may resolve to a stub or throw — in
  // either case the function must never throw and must return a summary.
  const result = await goalRecovery.recoverGoalRunsAfterBoot({
    logger: { info() {}, warn() {} },
    runInterval: false,
  });
  assert.ok(result, 'returns a summary object');
  assert.equal(typeof result.requeued, 'number');
  assert.equal(typeof result.stalled, 'number');
  assert.equal(typeof result.scanned, 'number');
});

test('routes/goals exports adminRouter with /health endpoint', () => {
  const adminRouter = goalsRoutes.adminRouter;
  assert.ok(adminRouter, 'adminRouter is exported');
  assert.equal(typeof adminRouter, 'function', 'adminRouter is callable middleware');
  assert.equal(typeof adminRouter.use, 'function', 'adminRouter has .use');
  assert.equal(typeof adminRouter.get, 'function', 'adminRouter has .get');

  // Inspect the express router stack for a GET /health registration.
  const stack = adminRouter.stack || [];
  const healthLayer = stack.find((layer) => {
    if (!layer || !layer.route) return false;
    const path = layer.route.path || '';
    const methods = layer.route.methods || {};
    return path === '/health' && methods.get;
  });
  assert.ok(healthLayer, 'admin router exposes GET /health');
});

test('routes/goals._internal exposes withTimeout helper', () => {
  const { withTimeout } = goalsRoutes._internal;
  assert.equal(typeof withTimeout, 'function');
});

test('withTimeout resolves to fallback when promise hangs past timeout', async () => {
  const { withTimeout } = goalsRoutes._internal;
  const hangingPromise = new Promise(() => {}); // never resolves
  const result = await withTimeout(hangingPromise, 10, { error: 'timeout' });
  assert.deepEqual(result, { error: 'timeout' });
});

test('withTimeout resolves to the promise value when it settles in time', async () => {
  const { withTimeout } = goalsRoutes._internal;
  const result = await withTimeout(Promise.resolve({ ok: true }), 1000, { error: 'fallback' });
  assert.deepEqual(result, { ok: true });
});

// ── goal-cleanup ───────────────────────────────────────────────────
test('goal-cleanup exports runGoalCleanupSweep, startGoalCleanup, stopGoalCleanup', () => {
  assert.equal(typeof goalCleanup.runGoalCleanupSweep, 'function');
  assert.equal(typeof goalCleanup.startGoalCleanup, 'function');
  assert.equal(typeof goalCleanup.stopGoalCleanup, 'function');
  assert.equal(typeof goalCleanup.readConfig, 'function');
});

test('goal-cleanup default retention is 30 days (2_592_000_000 ms)', () => {
  const previous = process.env.GOAL_CLEANUP_RETENTION_MS;
  delete process.env.GOAL_CLEANUP_RETENTION_MS;

  const cfg = goalCleanup.readConfig();
  assert.equal(cfg.retentionMs, 2_592_000_000, 'default retention = 30 days × 24h × 60m × 60s × 1000ms');
  assert.equal(goalCleanup.DEFAULT_RETENTION_MS, 2_592_000_000);

  if (previous !== undefined) process.env.GOAL_CLEANUP_RETENTION_MS = previous;
});

test('goal-cleanup default interval is 1 hour (3_600_000 ms)', () => {
  const previous = process.env.GOAL_CLEANUP_INTERVAL_MS;
  delete process.env.GOAL_CLEANUP_INTERVAL_MS;

  const cfg = goalCleanup.readConfig();
  assert.equal(cfg.intervalMs, 3_600_000, 'default interval = 60 minutes × 60s × 1000ms');
  assert.equal(goalCleanup.DEFAULT_INTERVAL_MS, 3_600_000);

  if (previous !== undefined) process.env.GOAL_CLEANUP_INTERVAL_MS = previous;
});

test('goal-cleanup readConfig honours env overrides for retention + interval', () => {
  const previous = {
    retention: process.env.GOAL_CLEANUP_RETENTION_MS,
    interval: process.env.GOAL_CLEANUP_INTERVAL_MS,
  };
  process.env.GOAL_CLEANUP_RETENTION_MS = '1000';
  process.env.GOAL_CLEANUP_INTERVAL_MS = '2000';

  const cfg = goalCleanup.readConfig();
  assert.equal(cfg.retentionMs, 1000);
  assert.equal(cfg.intervalMs, 2000);

  if (previous.retention === undefined) delete process.env.GOAL_CLEANUP_RETENTION_MS;
  else process.env.GOAL_CLEANUP_RETENTION_MS = previous.retention;
  if (previous.interval === undefined) delete process.env.GOAL_CLEANUP_INTERVAL_MS;
  else process.env.GOAL_CLEANUP_INTERVAL_MS = previous.interval;
});

test('goal-cleanup is enabled by default; readConfig.enabled === true when env unset', () => {
  const previous = process.env.GOAL_CLEANUP_ENABLED;
  delete process.env.GOAL_CLEANUP_ENABLED;

  const cfg = goalCleanup.readConfig();
  assert.equal(cfg.enabled, true);

  if (previous !== undefined) process.env.GOAL_CLEANUP_ENABLED = previous;
});

test('GOAL_CLEANUP_ENABLED=0 disables startGoalCleanup (no interval scheduled)', async () => {
  const previous = process.env.GOAL_CLEANUP_ENABLED;
  process.env.GOAL_CLEANUP_ENABLED = '0';

  // Safety: ensure no stray interval is dangling from a prior test.
  goalCleanup.stopGoalCleanup();

  const summary = await goalCleanup.startGoalCleanup({
    logger: { info() {}, warn() {} },
    runInterval: true,
  });
  assert.ok(summary, 'returns a summary even when disabled');
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'disabled');

  // stopGoalCleanup must be a no-op when nothing was scheduled.
  assert.doesNotThrow(() => goalCleanup.stopGoalCleanup());

  if (previous === undefined) delete process.env.GOAL_CLEANUP_ENABLED;
  else process.env.GOAL_CLEANUP_ENABLED = previous;
});

test('GOAL_CLEANUP_ENABLED=false also disables (case-insensitive)', () => {
  const previous = process.env.GOAL_CLEANUP_ENABLED;

  process.env.GOAL_CLEANUP_ENABLED = 'False';
  assert.equal(goalCleanup.readConfig().enabled, false);

  process.env.GOAL_CLEANUP_ENABLED = 'OFF';
  assert.equal(goalCleanup.readConfig().enabled, false);

  process.env.GOAL_CLEANUP_ENABLED = 'no';
  assert.equal(goalCleanup.readConfig().enabled, false);

  process.env.GOAL_CLEANUP_ENABLED = '1';
  assert.equal(goalCleanup.readConfig().enabled, true);

  if (previous === undefined) delete process.env.GOAL_CLEANUP_ENABLED;
  else process.env.GOAL_CLEANUP_ENABLED = previous;
});

test('stopGoalCleanup is safe to call when nothing was started', () => {
  // First call: no-op when nothing is running.
  assert.doesNotThrow(() => goalCleanup.stopGoalCleanup());
  // Idempotent — calling again must still be safe.
  assert.doesNotThrow(() => goalCleanup.stopGoalCleanup());
});

test('runGoalCleanupSweep returns a zeroed summary when prisma is unavailable', async () => {
  // The module lazy-requires `../config/database` and caches the result.
  // In the test runner the require may resolve to a stub or throw — in
  // either case the function must never throw and must return a summary.
  const result = await goalCleanup.runGoalCleanupSweep({
    logger: { info() {}, warn() {} },
  });
  assert.ok(result, 'returns a summary object');
  assert.equal(typeof result.deleted, 'number');
  assert.equal(typeof result.scanned, 'number');
  assert.equal(typeof result.durationMs, 'number');
});

// ── retry route ────────────────────────────────────────────────────
test('routes/goals exposes POST /:id/retry on the default router', () => {
  const stack = goalsRoutes.stack || [];
  const retryLayer = stack.find((layer) => {
    if (!layer || !layer.route) return false;
    const path = layer.route.path || '';
    const methods = layer.route.methods || {};
    return path === '/:id/retry' && methods.post;
  });
  assert.ok(retryLayer, 'default router exposes POST /:id/retry');
});
