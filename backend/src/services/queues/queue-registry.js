'use strict';

const { refreshQueueMetrics } = require('../../utils/metrics');

const JOB_STATES = Object.freeze([
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
  'paused',
]);

const DEFAULT_QUEUE_IDS = Object.freeze([
  'agent-task',
  'chat-run',
  'codex-runs',
  'document-collections',
  'goal-runs',
]);
// Backward-compatible logical names used by HEALTH_CRITICAL_QUEUES.
const DEFAULT_QUEUE_NAMES = DEFAULT_QUEUE_IDS;

const DEFAULT_QUEUE_SPECS = Object.freeze([
  Object.freeze({
    id: 'agent-task',
    envKey: 'AGENT_QUEUE_NAME',
    defaultName: 'siragpt-agent-tasks',
    getter: () => require('../agents/agent-task-queue').getAgentTaskQueue(),
  }),
  Object.freeze({
    id: 'chat-run',
    envKey: 'CHAT_RUN_QUEUE_NAME',
    defaultName: 'siragpt-chat-runs',
    getter: () => require('../chat-run-queue').getChatRunQueue(),
  }),
  Object.freeze({
    id: 'codex-runs',
    envKey: 'CODEX_QUEUE_NAME',
    defaultName: 'codex-runs',
    getter: () => require('../codex/run-queue').getCodexQueue(),
  }),
  Object.freeze({
    id: 'document-collections',
    envKey: 'DOCUMENT_COLLECTION_QUEUE_NAME',
    defaultName: 'siragpt-document-collections',
    getter: () => require('../document-collection-queue').getDocumentCollectionQueue(),
  }),
  Object.freeze({
    id: 'goal-runs',
    envKey: 'GOAL_QUEUE_NAME',
    defaultName: 'siragpt-goal-runs',
    getter: () => require('../goal-queue').getGoalQueue(),
  }),
]);

const DEFAULT_PHYSICAL_QUEUE_NAMES = Object.freeze(
  DEFAULT_QUEUE_SPECS.map((spec) => spec.defaultName),
);

const MAX_CRITICAL_QUEUES_ENV_CHARS = 512;
const DEFAULT_QUEUE_PROBE_TIMEOUT_MS = 1500;
const MIN_QUEUE_PROBE_TIMEOUT_MS = 100;
const MAX_QUEUE_PROBE_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_PROBE_CACHE_TTL_MS = 1000;
const MAX_QUEUE_PROBE_CACHE_TTL_MS = 5000;
const DEFAULT_QUEUE_METRICS_REFRESH_INTERVAL_MS = 30_000;
const MIN_QUEUE_METRICS_REFRESH_INTERVAL_MS = 1_000;
const MAX_QUEUE_METRICS_REFRESH_INTERVAL_MS = 300_000;

// Keep module loading lazy as well as Queue construction lazy. Listing this
// registry is used on no-Redis deployments and must not pull queue modules (or
// their BullMQ/ioredis dependencies) into the process.
function buildDefaultQueueDefinitions(env = process.env) {
  return DEFAULT_QUEUE_SPECS.map((spec) => Object.freeze({
    id: spec.id,
    name: String(env[spec.envKey] || spec.defaultName),
    getter: spec.getter,
  }));
}

const DEFAULT_QUEUE_DEFINITIONS = Object.freeze(buildDefaultQueueDefinitions({}));

const lastErrorsByRegistry = new WeakMap();

function parseCriticalQueueNames(value, allowedNames) {
  const allowed = new Set(allowedNames);
  const bounded = String(value || '').slice(0, MAX_CRITICAL_QUEUES_ENV_CHARS);
  const selected = new Set();
  for (const token of bounded.split(',')) {
    const name = token.trim();
    if (allowed.has(name)) selected.add(name);
    if (selected.size >= allowed.size) break;
  }
  return selected;
}

function normaliseDefinition(definition, criticalNames) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('queue definition must be an object');
  }
  const name = String(definition.name || '').trim();
  if (!name) throw new TypeError('queue definition name is required');
  const id = String(definition.id || name).trim();
  if (typeof definition.getter !== 'function') {
    throw new TypeError(`queue definition "${name}" requires a getter`);
  }
  const hasExplicitCritical = Object.prototype.hasOwnProperty.call(definition, 'critical');
  return Object.freeze({
    id,
    name,
    getter: definition.getter,
    critical: hasExplicitCritical
      ? Boolean(definition.critical)
      : criticalNames.has(id) || criticalNames.has(name),
  });
}

function createQueueRegistry({
  definitions = [],
  env = process.env,
} = {}) {
  const source = Array.from(definitions);
  const allowedCriticalNames = source.flatMap((definition) => [
    String(definition?.id || definition?.name || '').trim(),
    String(definition?.name || '').trim(),
  ]);
  const criticalNames = parseCriticalQueueNames(
    env.HEALTH_CRITICAL_QUEUES,
    allowedCriticalNames,
  );
  const entries = source.map((definition) => normaliseDefinition(definition, criticalNames));
  const byName = new Map();
  const byId = new Map();
  for (const definition of entries) {
    if (byName.has(definition.name)) {
      throw new TypeError(`queue definition "${definition.name}" is duplicated`);
    }
    if (byId.has(definition.id)) {
      throw new TypeError(`queue definition id "${definition.id}" is duplicated`);
    }
    byName.set(definition.name, definition);
    byId.set(definition.id, definition);
  }

  const registry = Object.freeze({
    list() {
      return Array.from(byName.values());
    },
    get(name) {
      const key = String(name);
      return byId.get(key) || byName.get(key) || null;
    },
  });
  lastErrorsByRegistry.set(registry, new Map());
  return registry;
}

function createDefaultQueueRegistry({ env = process.env } = {}) {
  return createQueueRegistry({
    definitions: buildDefaultQueueDefinitions(env),
    env,
  });
}

function errorMessage(error) {
  const message = error?.message || String(error || 'unknown queue error');
  return String(message).slice(0, 200);
}

function getQueueProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.HEALTH_QUEUE_PROBE_TIMEOUT_MS, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUEUE_PROBE_TIMEOUT_MS;
  return Math.min(MAX_QUEUE_PROBE_TIMEOUT_MS, Math.max(MIN_QUEUE_PROBE_TIMEOUT_MS, parsed));
}

function withQueueProbeTimeout(operation, { name, timeoutMs }) {
  let timer = null;
  const underlying = Promise.resolve().then(operation);
  // Promise.race observes late rejection, but retain an explicit rejection
  // sink so future refactors cannot turn a timed-out BullMQ command into an
  // unhandledRejection after readiness has already returned.
  underlying.catch(() => undefined);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`queue "${name}" probe timed out after ${timeoutMs}ms`);
      error.code = 'queue_probe_timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([underlying, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function emptyQueueSnapshot(definition, {
  status,
  lastError = null,
} = {}) {
  return {
    name: definition.name,
    critical: definition.critical,
    status,
    jobs: null,
    isPaused: null,
    lastError,
  };
}

function normaliseCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

async function inspectQueue(definition, getQueue) {
  const queue = await getQueue(definition);
  if (!queue || typeof queue.getJobCounts !== 'function') {
    throw new TypeError(`queue "${definition.name}" does not expose getJobCounts()`);
  }
  const rawCounts = await queue.getJobCounts(...JOB_STATES);
  const jobs = Object.fromEntries(
    JOB_STATES.map((state) => [state, normaliseCount(rawCounts?.[state])]),
  );
  const isPaused = typeof queue.isPaused === 'function'
    ? Boolean(await queue.isPaused())
    : false;
  return {
    name: definition.name,
    critical: definition.critical,
    status: 'ready',
    jobs,
    isPaused,
    lastError: null,
  };
}

async function probeQueue(definition, errors, timeoutMs, getQueue, onFailure) {
  try {
    const result = await withQueueProbeTimeout(
      () => inspectQueue(definition, getQueue),
      { name: definition.name, timeoutMs },
    );
    errors.delete(definition.name);
    return result;
  } catch (error) {
    if (typeof onFailure === 'function') {
      try {
        onFailure(definition, error);
      } catch (_) {
        // Reset is best-effort; the health result must still be returned.
      }
    }
    const lastError = errorMessage(error);
    errors.set(definition.name, lastError);
    return emptyQueueSnapshot(definition, {
      status: definition.critical ? 'unhealthy' : 'degraded',
      lastError,
    });
  }
}

async function probeQueueRegistry({
  registry = defaultQueueRegistry,
  env = process.env,
  getQueue = (definition) => definition.getter(),
  onFailure = null,
  onTimeout = null,
  now = Date.now,
} = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new TypeError('queue registry with list() is required');
  }
  const definitions = registry.list();
  const errors = lastErrorsByRegistry.get(registry) || new Map();
  if (!lastErrorsByRegistry.has(registry)) lastErrorsByRegistry.set(registry, errors);

  if (!env.REDIS_URL) {
    const snapshot = {
      status: 'disabled',
      reason: 'REDIS_URL is not configured',
      queues: definitions.map((definition) => emptyQueueSnapshot(definition, {
        status: 'skipped',
        lastError: errors.get(definition.name) || null,
      })),
    };
    refreshQueueMetrics(snapshot, { nowMs: now() });
    return snapshot;
  }

  const timeoutMs = getQueueProbeTimeoutMs(env);
  const queues = await Promise.all(
    definitions.map((definition) => probeQueue(
      definition,
      errors,
      timeoutMs,
      getQueue,
      onFailure || onTimeout,
    )),
  );
  let status = 'ready';
  if (queues.some((queue) => queue.status === 'unhealthy')) status = 'unhealthy';
  else if (queues.some((queue) => queue.status === 'degraded')) status = 'degraded';
  const snapshot = { status, queues };
  refreshQueueMetrics(snapshot, { nowMs: now() });
  return snapshot;
}

function getQueueProbeCacheTtlMs(env = process.env) {
  const parsed = Number.parseInt(env.HEALTH_QUEUE_PROBE_CACHE_TTL_MS, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_QUEUE_PROBE_CACHE_TTL_MS;
  return Math.min(MAX_QUEUE_PROBE_CACHE_TTL_MS, parsed);
}

function getQueueMetricsRefreshIntervalMs(env = process.env) {
  const parsed = Number.parseInt(env.HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_QUEUE_METRICS_REFRESH_INTERVAL_MS;
  }
  return Math.min(
    MAX_QUEUE_METRICS_REFRESH_INTERVAL_MS,
    Math.max(MIN_QUEUE_METRICS_REFRESH_INTERVAL_MS, parsed),
  );
}

function healthRedisConnectionOptions(env = process.env) {
  const timeoutMs = getQueueProbeTimeoutMs(env);
  return {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    retryStrategy(attempt) {
      return attempt <= 1 ? Math.min(50, timeoutMs) : null;
    },
  };
}

function defaultCreateHealthConnection({ redisUrl, options }) {
  const IORedis = require('ioredis');
  return new IORedis(redisUrl, options);
}

function defaultCreateHealthQueue({ name, connection, options }) {
  const { Queue } = require('bullmq');
  return new Queue(name, { connection, ...options });
}

function healthQueueOptions(env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.BULLMQ_SKIP_VERSION_CHECK || ''))) {
    return { skipVersionCheck: true };
  }
  try {
    if (env.REDIS_URL && /(^|\.)upstash\.io$/i.test(new URL(env.REDIS_URL).hostname)) {
      return { skipVersionCheck: true };
    }
  } catch (_) {
    // Invalid Redis URLs fail when the dedicated client is constructed.
  }
  return {};
}

function safelyDisconnect(connection) {
  if (!connection || typeof connection.disconnect !== 'function') return;
  try {
    connection.disconnect();
  } catch (_) {
    // Timeout reset is best-effort and must never delay readiness.
  }
}

function createQueueHealthProbeRuntime({
  registry = defaultQueueRegistry,
  env = process.env,
  cacheTtlMs = getQueueProbeCacheTtlMs(env),
  metricsRefreshIntervalMs = getQueueMetricsRefreshIntervalMs(env),
  createConnection = defaultCreateHealthConnection,
  createQueue = defaultCreateHealthQueue,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const instances = new Map();
  const boundedCacheTtlMs = Number.isFinite(cacheTtlMs)
    ? Math.min(MAX_QUEUE_PROBE_CACHE_TTL_MS, Math.max(0, Math.trunc(cacheTtlMs)))
    : DEFAULT_QUEUE_PROBE_CACHE_TTL_MS;
  let cached = null;
  let inFlight = null;
  let closePromise = null;
  let closed = false;
  let refreshTimer = null;
  let startPromise = null;
  const boundedMetricsRefreshIntervalMs = Number.isFinite(metricsRefreshIntervalMs)
    ? Math.min(
      MAX_QUEUE_METRICS_REFRESH_INTERVAL_MS,
      Math.max(MIN_QUEUE_METRICS_REFRESH_INTERVAL_MS, Math.trunc(metricsRefreshIntervalMs)),
    )
    : DEFAULT_QUEUE_METRICS_REFRESH_INTERVAL_MS;

  function instanceKey(definition) {
    return definition.id || definition.name;
  }

  function getHealthQueue(definition) {
    if (closed) throw new Error('queue health probe is closed');
    const key = instanceKey(definition);
    const existing = instances.get(key);
    if (existing) return existing.queue;

    const connection = createConnection({
      redisUrl: env.REDIS_URL,
      definition,
      options: healthRedisConnectionOptions(env),
    });
    if (typeof connection?.on === 'function') connection.on('error', () => {});

    let queue;
    try {
      queue = createQueue({
        id: definition.id,
        name: definition.name,
        definition,
        connection,
        options: healthQueueOptions(env),
      });
    } catch (error) {
      safelyDisconnect(connection);
      throw error;
    }
    if (typeof queue?.on === 'function') queue.on('error', () => {});
    instances.set(key, { queue, connection });
    return queue;
  }

  function resetHealthQueue(definition) {
    const key = instanceKey(definition);
    const instance = instances.get(key);
    if (!instance) return;
    instances.delete(key);
    safelyDisconnect(instance.connection);
  }

  function disabledSnapshot(reason) {
    return {
      status: 'disabled',
      reason,
      queues: registry.list().map((definition) => emptyQueueSnapshot(definition, {
        status: 'skipped',
      })),
    };
  }

  function probe({ bypassCache = false } = {}) {
    if (closed) return Promise.resolve(disabledSnapshot('queue health probe is closed'));
    const timestamp = now();
    if (!bypassCache && cached && (timestamp - cached.at) < boundedCacheTtlMs) {
      return Promise.resolve(cached.snapshot);
    }
    if (inFlight) return inFlight;

    const current = Promise.resolve()
      .then(() => probeQueueRegistry({
        registry,
        env,
        getQueue: getHealthQueue,
        onFailure: resetHealthQueue,
        now,
      }))
      .then((snapshot) => {
        if (!closed && boundedCacheTtlMs > 0) {
          cached = { at: now(), snapshot };
        }
        return snapshot;
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  }

  function runScheduledRefresh() {
    return probe({ bypassCache: true }).catch(() => null);
  }

  function start() {
    if (closed) return Promise.resolve(disabledSnapshot('queue health probe is closed'));
    if (refreshTimer) {
      return startPromise || Promise.resolve(cached?.snapshot || disabledSnapshot('queue refresh already started'));
    }
    refreshTimer = setIntervalFn(runScheduledRefresh, boundedMetricsRefreshIntervalMs);
    if (typeof refreshTimer?.unref === 'function') refreshTimer.unref();
    startPromise = runScheduledRefresh().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function stop() {
    if (!refreshTimer) return false;
    clearIntervalFn(refreshTimer);
    refreshTimer = null;
    return true;
  }

  async function closeInstance(instance) {
    try {
      if (typeof instance.queue?.close === 'function') await instance.queue.close();
    } catch (_) {
      // Continue to the connection close fallback.
    }
    try {
      if (typeof instance.connection?.quit === 'function') {
        await instance.connection.quit();
      } else {
        safelyDisconnect(instance.connection);
      }
    } catch (_) {
      safelyDisconnect(instance.connection);
    }
  }

  function close() {
    if (closePromise) return closePromise;
    stop();
    closed = true;
    cached = null;
    const activeProbe = inFlight;
    const activeInstances = Array.from(instances.values());
    instances.clear();
    for (const instance of activeInstances) safelyDisconnect(instance.connection);
    closePromise = Promise.allSettled([
      ...activeInstances.map((instance) => closeInstance(instance)),
      ...(activeProbe ? [activeProbe] : []),
    ]).then(() => undefined);
    return closePromise;
  }

  return Object.freeze({
    start,
    stop,
    probe,
    close,
  });
}

const defaultQueueRegistry = createDefaultQueueRegistry();
const defaultQueueHealthProbe = createQueueHealthProbeRuntime({
  registry: defaultQueueRegistry,
});

module.exports = {
  DEFAULT_QUEUE_IDS,
  DEFAULT_QUEUE_METRICS_REFRESH_INTERVAL_MS,
  DEFAULT_QUEUE_PROBE_CACHE_TTL_MS,
  DEFAULT_QUEUE_PROBE_TIMEOUT_MS,
  DEFAULT_QUEUE_DEFINITIONS,
  DEFAULT_QUEUE_NAMES,
  DEFAULT_PHYSICAL_QUEUE_NAMES,
  JOB_STATES,
  MAX_CRITICAL_QUEUES_ENV_CHARS,
  MAX_QUEUE_METRICS_REFRESH_INTERVAL_MS,
  MAX_QUEUE_PROBE_CACHE_TTL_MS,
  MAX_QUEUE_PROBE_TIMEOUT_MS,
  MIN_QUEUE_PROBE_TIMEOUT_MS,
  MIN_QUEUE_METRICS_REFRESH_INTERVAL_MS,
  buildDefaultQueueDefinitions,
  createDefaultQueueRegistry,
  createQueueHealthProbeRuntime,
  createQueueRegistry,
  defaultQueueHealthProbe,
  defaultQueueRegistry,
  getQueueMetricsRefreshIntervalMs,
  getQueueProbeCacheTtlMs,
  getQueueProbeTimeoutMs,
  healthRedisConnectionOptions,
  parseCriticalQueueNames,
  probeQueueRegistry,
};
