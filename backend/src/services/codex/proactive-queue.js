'use strict';

const QUEUE_NAME = 'codex-proactive';

let runtime = null;

function intervalMs(env = process.env) {
  const raw = Number.parseInt(env.CODEX_PROACTIVE_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 2 * 60_000;
}

async function processProactiveTick({
  env = process.env,
  deps = {},
  proactive = require('./proactive-engine'),
  digest = require('./proactive-digest'),
} = {}) {
  const results = await proactive.tickAll({ deps, env });
  const digestResult = await digest.sendDailyDigest({
    prisma: deps.prisma,
    env,
  }).catch((error) => ({
    action: 'send_failed',
    error: String(error?.message || error).slice(0, 240),
  }));
  return { results, digest: digestResult };
}

async function startProactiveScheduler({
  env = process.env,
  deps = {},
  QueueImpl,
  WorkerImpl,
  createConnection,
  runtimeOptions,
  proactive,
  digest,
} = {}) {
  if (runtime) return runtime;
  const engine = proactive || require('./proactive-engine');
  if (!engine.tickerEnabled(env) || !env.REDIS_URL) return null;

  const bullmq = QueueImpl && WorkerImpl ? null : require('bullmq');
  const QueueClass = QueueImpl || bullmq.Queue;
  const WorkerClass = WorkerImpl || bullmq.Worker;
  const queueRuntime = (!createConnection || !runtimeOptions) ? require('./run-queue') : null;
  const connect = createConnection || queueRuntime.createRedisConnection;
  const options = runtimeOptions || (() => queueRuntime.getRuntimeOptions({ redisUrl: env.REDIS_URL }));
  const queueConnection = connect({ label: 'codex-proactive-queue' });
  const workerConnection = connect({ label: 'codex-proactive-worker' });
  const queue = new QueueClass(QUEUE_NAME, {
    ...options(),
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 },
    },
  });
  const handler = () => processProactiveTick({ env, deps, proactive: engine, digest });
  const worker = new WorkerClass(QUEUE_NAME, handler, {
    ...options(),
    connection: workerConnection,
    concurrency: 1,
    lockDuration: Math.max(60_000, intervalMs(env)),
  });
  queue.on?.('error', (error) => console.warn('[codex proactive] queue error:', error?.message || error));
  worker.on?.('error', (error) => console.warn('[codex proactive] worker error:', error?.message || error));
  worker.on?.('failed', (job, error) => {
    console.warn(`[codex proactive] job ${job?.id || '(unknown)'} failed:`, error?.message || error);
  });

  const schedulerId = 'codex-proactive-tick';
  if (typeof queue.upsertJobScheduler === 'function') {
    await queue.upsertJobScheduler(
      schedulerId,
      { every: intervalMs(env) },
      { name: 'tick', data: {}, opts: { removeOnComplete: true } },
    );
  } else {
    await queue.add('tick', {}, {
      jobId: schedulerId,
      repeat: { every: intervalMs(env) },
      removeOnComplete: true,
    });
  }

  runtime = Object.freeze({ queue, worker, queueConnection, workerConnection });
  return runtime;
}

async function closeProactiveScheduler() {
  const current = runtime;
  runtime = null;
  if (!current) return;
  await Promise.allSettled([
    current.worker?.close?.(),
    current.queue?.close?.(),
  ]);
  await Promise.allSettled([
    current.workerConnection?.quit?.().catch?.(() => current.workerConnection?.disconnect?.()),
    current.queueConnection?.quit?.().catch?.(() => current.queueConnection?.disconnect?.()),
  ]);
}

function __resetForTests() {
  runtime = null;
}

module.exports = {
  QUEUE_NAME,
  __resetForTests,
  closeProactiveScheduler,
  intervalMs,
  processProactiveTick,
  startProactiveScheduler,
};
