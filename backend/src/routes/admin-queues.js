'use strict';

const express = require('express');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const {
  getAgentTaskQueue,
  getQueueHealth,
  getQueueName,
} = require('../services/agents/agent-task-queue');

const BOARD_BASE_PATH = '/api/admin/queues/board';

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
  getHealth = getQueueHealth,
} = {}) {
  const config = resolveQueueBoardConfig(env);
  if (!config.redisUrlConfigured) {
    return {
      ...config,
      status: 'disabled',
      reason: 'REDIS_URL is not configured',
      counts: null,
    };
  }

  try {
    const health = await getHealth();
    return {
      ...config,
      status: 'ready',
      counts: health.counts || {},
    };
  } catch (error) {
    return {
      ...config,
      status: 'degraded',
      reason: error?.message || 'Queue health check failed',
      counts: null,
    };
  }
}

function getBullBoardRuntime() {
  if (boardRuntime) return boardRuntime;
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BOARD_BASE_PATH);
  const queue = getAgentTaskQueue();
  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter,
  });
  boardRuntime = {
    serverAdapter,
    mountedAt: new Date().toISOString(),
  };
  return boardRuntime;
}

function createAdminQueuesRouter() {
  const router = express.Router();
  router.use(authenticateToken, requireAdmin);

  router.get('/status', async (_req, res) => {
    const status = await buildQueueBoardStatus();
    res.status(status.status === 'degraded' ? 503 : 200).json({ ok: status.status !== 'degraded', queueBoard: status });
  });

  router.use('/board', (req, res, next) => {
    if (!process.env.REDIS_URL) {
      res.status(503).json({
        error: 'Queue dashboard is disabled because REDIS_URL is not configured',
        code: 'queue_dashboard_disabled',
      });
      return;
    }

    try {
      const runtime = getBullBoardRuntime();
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
  getBullBoardRuntime,
  resolveQueueBoardConfig,
};
