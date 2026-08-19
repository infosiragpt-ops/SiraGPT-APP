'use strict';

const express = require('express');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { authenticateToken, requireSuperAdmin } = require('../middleware/auth');
const requireAdminRoutePermission = require('../services/admin-route-policy');
const {
  getQueueName,
} = require('../services/agents/agent-task-queue');
const {
  createQueueHealthProbeRuntime,
  defaultQueueHealthProbe: queueHealthProbe,
  defaultQueueRegistry: queueRegistry,
  probeQueueRegistry,
} = require('../services/queues/queue-registry');

const BOARD_BASE_PATH = '/api/admin/queues/board';

async function buildQueuesHealthSnapshot(options = {}) {
  const env = options.env || process.env;
  if (options.registry) {
    return probeQueueRegistry({
      registry: options.registry,
      env,
    });
  }
  if (options.queueHealthProbe) return options.queueHealthProbe.probe();
  if (Object.prototype.hasOwnProperty.call(options, 'env')) {
    const runtime = createQueueHealthProbeRuntime({
      registry: queueRegistry,
      env,
      cacheTtlMs: 0,
    });
    try {
      return await runtime.probe();
    } finally {
      await runtime.close();
    }
  }
  return queueHealthProbe.probe();
}

let boardRuntime = null;

function resolveQueueBoardConfig(env = process.env) {
  return {
    enabled: Boolean(env.REDIS_URL),
    redisUrlConfigured: Boolean(env.REDIS_URL),
    queue: env.AGENT_QUEUE_NAME || getQueueName(),
    basePath: BOARD_BASE_PATH,
  };
}

async function buildQueueBoardStatus({
  env = process.env,
  getSnapshot = null,
} = {}) {
  const config = resolveQueueBoardConfig(env);
  try {
    const snapshot = await (getSnapshot || (() => buildQueuesHealthSnapshot({ env })))();
    const queues = Array.isArray(snapshot?.queues) ? snapshot.queues : [];
    const agentQueue = queues.find((queue) => queue?.name === config.queue) || null;
    const reason = snapshot?.reason
      || queues.find((queue) => queue?.lastError)?.lastError
      || null;
    return {
      ...config,
      status: snapshot?.status || 'degraded',
      counts: agentQueue?.jobs || null,
      queues,
      ...(reason ? { reason } : {}),
    };
  } catch (error) {
    return {
      ...config,
      status: 'degraded',
      reason: error?.message || 'Queue health check failed',
      counts: null,
      queues: [],
    };
  }
}

function summariseQueueStatuses(queues) {
  const summary = {
    total: 0,
    ready: 0,
    degraded: 0,
    unhealthy: 0,
    skipped: 0,
    criticalFailures: 0,
  };
  for (const queue of Array.isArray(queues) ? queues : []) {
    summary.total += 1;
    switch (queue?.status) {
      case 'ready':
      case 'degraded':
      case 'unhealthy':
      case 'skipped':
        summary[queue.status] += 1;
        break;
      default:
        break;
    }
    if (queue?.critical && queue?.status === 'unhealthy') {
      summary.criticalFailures += 1;
    }
  }
  return summary;
}

function publicQueueBoardStatus(status) {
  return {
    enabled: Boolean(status?.enabled),
    redisUrlConfigured: Boolean(status?.redisUrlConfigured),
    queue: String(status?.queue || ''),
    basePath: String(status?.basePath || BOARD_BASE_PATH),
    status: status?.status || 'degraded',
    counts: status?.counts ?? null,
    queueCounts: summariseQueueStatuses(status?.queues),
  };
}

function createBullBoardRuntime({
  registry = queueRegistry,
  createBoard = createBullBoard,
  BullMQAdapterClass = BullMQAdapter,
  ExpressAdapterClass = ExpressAdapter,
} = {}) {
  const serverAdapter = new ExpressAdapterClass();
  serverAdapter.setBasePath(BOARD_BASE_PATH);
  const definitions = registry.list();
  const queues = definitions.map((definition) => (
    new BullMQAdapterClass(definition.getter())
  ));
  createBoard({
    queues,
    serverAdapter,
  });
  return {
    serverAdapter,
    mountedAt: new Date().toISOString(),
    queueNames: definitions.map((definition) => definition.name),
  };
}

function getBullBoardRuntime() {
  if (boardRuntime) return boardRuntime;
  boardRuntime = createBullBoardRuntime();
  return boardRuntime;
}

function createAdminQueuesRouter({
  authenticateMiddleware = authenticateToken,
  requireAdminMiddleware = requireAdminRoutePermission,
  requireSuperAdminMiddleware = requireSuperAdmin,
  getHealthSnapshot = buildQueuesHealthSnapshot,
  getBoardRuntime = getBullBoardRuntime,
  env = process.env,
} = {}) {
  const router = express.Router();
  router.use(authenticateMiddleware, requireAdminMiddleware);

  router.get('/status', async (_req, res) => {
    const status = await buildQueueBoardStatus({
      env,
      getSnapshot: getHealthSnapshot,
    });
    const queueBoard = publicQueueBoardStatus(status);
    const code = queueBoard.status === 'unhealthy' ? 503 : 200;
    res.status(code).json({ ok: queueBoard.status !== 'unhealthy', queueBoard });
  });

  // Ratchet 45 — per-queue health snapshot for every BullMQ queue
  // registered with this process. Reuses the BullMQ JobCounts probe so
  // it overlaps with the existing /status payload, but adds a richer
  // structure (per-queue { name, jobs, isPaused, lastError }) for the
  // SRE dashboard. Super-admin only because raw counts can leak tenant
  // signal (e.g. job spikes correlated to a customer rollout).
  router.get('/health', requireSuperAdminMiddleware, async (_req, res) => {
    const snapshot = await getHealthSnapshot();
    const code = snapshot.status === 'unhealthy' ? 503 : 200;
    res.status(code).json({ ok: snapshot.status === 'ready', ...snapshot });
  });

  router.use('/board', requireSuperAdminMiddleware, (req, res, next) => {
    if (!env.REDIS_URL) {
      res.status(503).json({
        error: 'Queue dashboard is disabled because REDIS_URL is not configured',
        code: 'queue_dashboard_disabled',
      });
      return;
    }

    try {
      const runtime = getBoardRuntime();
      runtime.serverAdapter.getRouter()(req, res, next);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createAdminQueuesRouter();
module.exports.INTERNAL = {
  BOARD_BASE_PATH,
  buildQueueBoardStatus,
  buildQueuesHealthSnapshot,
  createAdminQueuesRouter,
  createBullBoardRuntime,
  getBullBoardRuntime,
  publicQueueBoardStatus,
  queueHealthProbe,
  queueRegistry,
  resolveQueueBoardConfig,
  summariseQueueStatuses,
};
