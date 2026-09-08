'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const runQueue = require('../src/services/codex/run-queue');

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of [
    'CODEX_QUEUE_NAME',
    'CODEX_AGENT_V2',
    'REDIS_URL',
    'BULLMQ_SKIP_VERSION_CHECK',
    'CODEX_WORKER_CONCURRENCY',
    'CODEX_WORKER_MAX_CONCURRENCY',
    'CODEX_AUTOSCALE_QUEUE_DEPTH',
    'CODEX_AUTOSCALE_STEP',
    'CODEX_AUTOSCALE_SCALE_DOWN_MS',
    'CODEX_AUTOSCALE_INTERVAL_MS',
  ]) {
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
  assert.equal(runQueue.startCodexWorker({
    env: { CODEX_AGENT_V2: '', CODEX_IMPLEMENTER_ADAPTER: 'not-installed' },
  }), null);
});

test('startCodexWorker is a no-op (null) when the flag is on but REDIS_URL is absent', () => {
  delete process.env.REDIS_URL;
  assert.equal(runQueue.startCodexWorker({ env: { CODEX_AGENT_V2: '1' } }), null);
});

test('startCodexWorker fails closed before Redis for an unknown implementer adapter', () => {
  delete process.env.REDIS_URL;
  assert.throws(
    () => runQueue.startCodexWorker({
      env: { CODEX_AGENT_V2: '1', CODEX_IMPLEMENTER_ADAPTER: 'not-installed' },
    }),
    /CODEX_IMPLEMENTER_ADAPTER=not-installed is unsupported/,
  );
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
    await runQueue.enqueueCodexRun({
      runId: 'r1',
      jobId: 'r1:r1',
      resumeSnapshot: { sessionId: 'r1', cursorSeq: 9, checkpointSha: 'deadbee' },
    }); // boot-recovery resume shape
    await runQueue.enqueueCodexRun({ runId: 'r1' }, { jobId: 'r1:rq5' }); // opts shape
    await runQueue.enqueueCodexRun({ runId: 'r1' }); // default: idempotent on runId
    assert.deepEqual(adds.map((a) => a.opts.jobId), ['r1:r1', 'r1:rq5', 'r1']);
    assert.ok(adds.every((a) => a.name === 'codex-run' && a.data.runId === 'r1'));
    assert.deepEqual(adds[0].data.resumeSnapshot, { sessionId: 'r1', cursorSeq: 9, checkpointSha: 'deadbee' });
  } finally {
    runQueue.__setQueueForTests(null);
  }
});

test('default handler pins the adapter id validated at boot and captures injected env', async () => {
  const env = {
    CODEX_AGENT_V2: '1',
    CODEX_IMPLEMENTER_ADAPTER: 'native',
    CODEX_RUN_TIMEOUT_MS: '1234',
  };
  const calls = [];
  const handler = runQueue.createDefaultCodexJobHandler({
    env,
    processRun: async (args) => { calls.push(args); return { status: 'done' }; },
  });
  env.CODEX_IMPLEMENTER_ADAPTER = 'not-installed';
  env.CODEX_RUN_TIMEOUT_MS = '9999';

  await handler({ data: { runId: 'run-1', resumeSnapshot: { sessionId: 'run-1', cursorSeq: 4 } } });
  assert.equal(calls[0].runId, 'run-1');
  assert.deepEqual(calls[0].resumeSnapshot, { sessionId: 'run-1', cursorSeq: 4, checkpointSha: null });
  assert.equal(calls[0].env.CODEX_IMPLEMENTER_ADAPTER, 'native');
  assert.equal(calls[0].env.CODEX_RUN_TIMEOUT_MS, '1234');
  assert.equal(Object.isFrozen(calls[0].env), true);
});

// ── Autoscaler: hot concurrency for the codex-runs worker ──────────────────

const AUTOSCALER_CONFIG = {
  enabled: true,
  floor: 2,
  ceiling: 8,
  scaleUpThreshold: 3,
  scaleUpStep: 2,
  scaleDownAfterMs: 120_000,
  intervalMs: 15_000,
};

test('getAutoscalerConfig floors at the operator concurrency and disables when ceiling <= floor', () => {
  const base = runQueue.getAutoscalerConfig({ CODEX_WORKER_CONCURRENCY: '4' });
  assert.equal(base.floor, 4);
  assert.equal(base.ceiling, 8);
  assert.equal(base.enabled, true);

  const inert = runQueue.getAutoscalerConfig({ CODEX_WORKER_CONCURRENCY: '8' });
  assert.equal(inert.enabled, false);

  // A ceiling below the operator floor never pulls capacity DOWN.
  const clamped = runQueue.getAutoscalerConfig({
    CODEX_WORKER_CONCURRENCY: '6',
    CODEX_WORKER_MAX_CONCURRENCY: '3',
  });
  assert.equal(clamped.enabled, false);
  assert.equal(clamped.ceiling, 6);

  const junk = runQueue.getAutoscalerConfig({ CODEX_WORKER_MAX_CONCURRENCY: 'not-a-number' });
  assert.equal(junk.ceiling, 8);
});

test('nextAutoscalerTarget scales up by step when waiting depth exceeds threshold', () => {
  const next = runQueue.nextAutoscalerTarget({
    depth: 5,
    current: 2,
    busySinceMs: null,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(next.target, 4);
  assert.equal(next.changed, true);
  assert.equal(next.busySinceMs, 1_000);
});

test('nextAutoscalerTarget never exceeds the ceiling and holds below threshold while hot', () => {
  const atCeiling = runQueue.nextAutoscalerTarget({
    depth: 50,
    current: 8,
    busySinceMs: 500,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(atCeiling.target, 8);
  assert.equal(atCeiling.changed, false);

  const holding = runQueue.nextAutoscalerTarget({
    depth: 2,
    current: 6,
    busySinceMs: 1_000 - 10_000,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(holding.target, 6);
  assert.equal(holding.changed, false);
});

test('nextAutoscalerTarget scales down to floor only after the quiet period', () => {
  const stillHot = runQueue.nextAutoscalerTarget({
    depth: 0,
    current: 6,
    busySinceMs: 1_000 - 119_999,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(stillHot.target, 6);
  assert.equal(stillHot.changed, false);

  const cooled = runQueue.nextAutoscalerTarget({
    depth: 0,
    current: 6,
    busySinceMs: 1_000 - 120_000,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(cooled.target, 2);
  assert.equal(cooled.changed, true);
  assert.equal(cooled.busySinceMs, null);

  const idleAtFloor = runQueue.nextAutoscalerTarget({
    depth: 0,
    current: 2,
    busySinceMs: null,
    now: 1_000,
    config: AUTOSCALER_CONFIG,
  });
  assert.equal(idleAtFloor.target, 2);
  assert.equal(idleAtFloor.changed, false);
});

test('startCodexAutoscaler is a no-op without a live worker (no Redis touched)', () => {
  assert.equal(runQueue.startCodexAutoscaler({ env: { CODEX_WORKER_CONCURRENCY: '2' } }), null);
});
