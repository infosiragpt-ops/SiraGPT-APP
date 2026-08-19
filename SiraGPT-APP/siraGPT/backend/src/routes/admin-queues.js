'use strict';

const express = require('express');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { authenticateToken, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const {
  getAgentTaskQueue,
  getQueueHealth,
  getQueueName,
} = require('../services/agents/agent-task-queue');

const BOARD_BASE_PATH = '/api/admin/queues/board';

// ── Queue registry (ratchet 45) ──────────────────────────────────────
// Health snapshot endpoint enumerates every BullMQ queue registered in
// this process. Today only the agent-task queue is wired; the registry
// keeps the contract future-proof so new queues (e.g. webhook delivery,
// background analyzer) can opt in with one registerQueue() call without
// touching the route. Each entry carries a lazy `get()` so we never
// instantiate Redis connections until the snapshot is actually polled.
const _registeredQueues = new Map();

function registerQueue(name, getter) {
  if (!name || typeof getter !== 'function') return;
  _registeredQueues.set(String(name), getter);
}

function _defaultRegistry() {
  // Lazy-default: register the agent-task queue if no one has registered
  // anything yet. We do this on first read so test harnesses can install
  // their own registry without colliding.
  if (_registeredQueues.size === 0) {
    _registeredQueues.set(getQueueName(), () => getAgentTaskQueue());
  }
  return _registeredQueues;
}

// lastError ring per queue — set whenever a snapshot probe fails so the
// next read can surface "this queue was unreachable last time we tried"
// without spamming Redis on every poll.
const _lastErrorByQueue = new Map();

async function _probeQueueHealth(name, getter) {
  let queue;
  try {
    queue = getter();
  } catch (err) {
    _lastErrorByQueue.set(name, err?.message || String(err));
    return {
      name,
      jobs: null,
      isPaused: null,
      lastError: _lastErrorByQueue.get(name),
    };
  }

  // getJobCounts is the canonical BullMQ snapshot helper; we ask for
  // every state the dashboard cares about plus `paused` (which BullMQ
  // includes when the queue itself is paused so jobs accumulate).
  try {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    let isPaused = false;
    try {
      if (typeof queue.isPaused === 'function') isPaused = Boolean(await queue.isPaused());
    } catch (_) {
      // BullMQ versions where isPaused throws on a disconnected client —
      // we treat that as "unknown" rather than failing the whole probe.
      isPaused = false;
    }
    // Clear the lastError ring on a successful probe.
    const prevErr = _lastErrorByQueue.get(name) || null;
    _lastErrorByQueue.delete(name);
    return {
      name,
      jobs: {
        waiting: Number(counts.waiting) || 0,
        active: Number(counts.active) || 0,
        completed: Number(counts.completed) || 0,
        failed: Number(counts.failed) || 0,
        delayed: Number(counts.delayed) || 0,
        paused: Number(counts.paused) || 0,
      },
      isPaused,
      lastError: prevErr,
    };
  } catch (err) {
    const message = err?.message || String(err);
    _lastErrorByQueue.set(name, message);
    return {
      name,
      jobs: null,
      isPaused: null,
      lastError: message,
    };
  }
}

async function buildQueuesHealthSnapshot({
  env = process.env,
  registry = _defaultRegistry(),
} = {}) {
  if (!env.REDIS_URL) {
    return {
      status: 'disabled',
      reason: 'REDIS_URL is not configured',
      queues: [],
    };
  }
  const queues = [];
  for (const [name, getter] of registry) {
    // eslint-disable-next-line no-await-in-loop
    queues.push(await _probeQueueHealth(name, getter));
  }
  const anyError = queues.some((q) => q.lastError);
  return {
    status: anyError ? 'degraded' : 'ready',
    queues,
  };
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

  // Ratchet 45 — per-queue health snapshot for every BullMQ queue
  // registered with this process. Reuses the BullMQ JobCounts probe so
  // it overlaps with the existing /status payload, but adds a richer
  // structure (per-queue { name, jobs, isPaused, lastError }) for the
  // SRE dashboard. Super-admin only because raw counts can leak tenant
  // signal (e.g. job spikes correlated to a customer rollout).
  router.get('/health', requireSuperAdmin, async (_req, res) => {
    const snapshot = await buildQueuesHealthSnapshot();
    const code = snapshot.status === 'ready' ? 200
      : snapshot.status === 'disabled' ? 503
      : 503; // degraded
    res.status(code).json({ ok: snapshot.status === 'ready', ...snapshot });
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
  buildQueuesHealthSnapshot,
  getBullBoardRuntime,
  registerQueue,
  resolveQueueBoardConfig,
  _registeredQueues,
  _lastErrorByQueue,
};
