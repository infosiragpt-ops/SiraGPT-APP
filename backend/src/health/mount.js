'use strict';

const { HealthRegistry } = require('./probe');
const {
  ProbeScheduler,
  DEFAULT_INTERVAL_MS,
  MAX_TIMER_DELAY_MS,
} = require('./probe-scheduler');
const { createDbProbe } = require('./probes/db');
const { createRedisProbe } = require('./probes/redis');
const { createMemoryProbe } = require('./probes/memory');
const { createDiskProbe } = require('./probes/disk');
const { createOpenAIProbe } = require('./probes/provider-openai');
const { createConfiguredLlmProbes } = require('./probes/provider-llm');
const { createConfiguredExternalProbes } = require('./probes/provider-external');
const {
  createOperationalAccessPolicy,
} = require('../services/observability/operational-auth');

const MIN_SCHEDULER_INTERVAL_MS = 1000;
const DEFAULT_SCHEDULED_PROBES = new Set(['database', 'redis', 'memory', 'disk']);

function resolveSchedulerIntervalMs(env = process.env) {
  const raw = env?.HEALTH_PROBE_INTERVAL_MS ?? env?.HEALTH_SCHEDULER_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(MIN_SCHEDULER_INTERVAL_MS, parsed),
  );
}

function shouldScheduleProviderProbes(env = process.env) {
  return String(env?.HEALTH_SCHEDULE_PROVIDER_PROBES || '').trim().toLowerCase() === 'true';
}

function shouldRegisterProviderProbes(env = process.env) {
  return String(env?.HEALTH_PROVIDER_PROBES_ENABLED || '').trim().toLowerCase() === 'true';
}

function shouldAllowInternalHealthLoopback(env = process.env) {
  const isProduction = String(env?.NODE_ENV || '').trim().toLowerCase() === 'production';
  const explicitlyAllowed = String(env?.INTERNAL_HEALTH_ALLOW_LOOPBACK || '')
    .trim()
    .toLowerCase() === 'true';
  return !isProduction || explicitlyAllowed;
}

function noStore(_req, res, next) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store');
  } else if (typeof res.set === 'function') {
    res.set('Cache-Control', 'no-store');
  }
  return next();
}

function createHealthSystem({
  prisma,
  redisClient,
  logger = console,
  env = process.env,
  accessPolicy,
  authMiddlewares,
} = {}) {
  const registry = new HealthRegistry();
  const healthAccessPolicy = accessPolicy || createOperationalAccessPolicy({
    env,
    tokenEnvNames: ['INTERNAL_HEALTH_TOKEN', 'METRICS_TOKEN'],
    authMiddlewares,
    allowLoopback: shouldAllowInternalHealthLoopback(env),
    denyForwardedLoopback: true,
  });

  try {
    if (prisma?.$queryRaw) {
      registry.add(createDbProbe({ prisma }));
    }
  } catch (err) {
    logger.warn?.({ err }, 'health: db probe not available');
  }

  try {
    if (redisClient?.ping) {
      registry.add(createRedisProbe({ client: redisClient }));
    }
  } catch (err) {
    logger.warn?.({ err }, 'health: redis probe not available');
  }

  try {
    registry.add(createMemoryProbe());
  } catch (err) {
    logger.warn?.({ err }, 'health: memory probe not available');
  }

  try {
    registry.add(createDiskProbe());
  } catch (err) {
    logger.warn?.({ err }, 'health: disk probe not available');
  }

  if (shouldRegisterProviderProbes(env)) {
    try {
      if (env.OPENAI_API_KEY && String(env.OPENAI_API_KEY).trim()) {
        registry.add(createOpenAIProbe());
      }
    } catch (err) {
      logger.warn?.({ err }, 'health: openai provider probe not available');
    }

    try {
      const llmProbes = createConfiguredLlmProbes({ env });
      for (const probe of llmProbes) {
        try {
          registry.add(probe);
        } catch (err) {
          logger.warn?.({ err, name: probe.name }, 'health: llm provider probe registration failed');
        }
      }
    } catch (err) {
      logger.warn?.({ err }, 'health: llm provider probes not available');
    }

    try {
      const externalProbes = createConfiguredExternalProbes({ env });
      for (const probe of externalProbes) {
        try {
          registry.add(probe);
        } catch (err) {
          logger.warn?.({ err, name: probe.name }, 'health: external provider probe registration failed');
        }
      }
    } catch (err) {
      logger.warn?.({ err }, 'health: external provider probes not available');
    }
  }

  const scheduler = new ProbeScheduler({
    defaultIntervalMs: resolveSchedulerIntervalMs(env),
    onError: ({ name, error }) => {
      logger.warn?.({ err: error, name }, 'health: scheduled probe failed');
    },
  });
  const scheduleProviders = shouldScheduleProviderProbes(env);
  for (const probe of registry.list()) {
    if (DEFAULT_SCHEDULED_PROBES.has(probe.name) || (scheduleProviders && probe.name.startsWith('provider-'))) {
      scheduler.add(probe, { runImmediately: true });
    }
  }

  return {
    registry,
    scheduler,
    livenessHandler: registry.liveHandler(),
    readinessHandler: registry.readyHandler(),
    historyHandler: registry.historyHandler(),

    mount(app) {
      app.get('/internal/health/live', noStore, healthAccessPolicy, this.livenessHandler);
      app.get('/internal/health/ready', noStore, healthAccessPolicy, this.readinessHandler);
      app.get('/internal/health/history', noStore, healthAccessPolicy, this.historyHandler);
    },

    startScheduler() {
      if (scheduler.running) return false;
      scheduler.start();
      logger.info?.('health: probe scheduler started');
      return true;
    },

    stopScheduler() {
      if (!scheduler.running) return false;
      scheduler.stop();
      return true;
    },
  };
}

module.exports = {
  createHealthSystem,
  resolveSchedulerIntervalMs,
  shouldAllowInternalHealthLoopback,
  shouldRegisterProviderProbes,
  shouldScheduleProviderProbes,
  MIN_SCHEDULER_INTERVAL_MS,
};
