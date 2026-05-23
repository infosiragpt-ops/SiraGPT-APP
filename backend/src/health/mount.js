'use strict';

const { HealthRegistry, Probe, CATEGORY } = require('./probe');
const { ProbeScheduler } = require('./probe-scheduler');
const { createDbProbe } = require('./probes/db');
const { createRedisProbe } = require('./probes/redis');
const { createMemoryProbe } = require('./probes/memory');
const { createDiskProbe } = require('./probes/disk');
const { createOpenAIProbe } = require('./probes/provider-openai');
const { createConfiguredLlmProbes } = require('./probes/provider-llm');

function createHealthSystem({ prisma, redisClient, logger = console, env = process.env } = {}) {
  const registry = new HealthRegistry();

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

  const scheduler = new ProbeScheduler({ registry });

  return {
    registry,
    scheduler,
    livenessHandler: registry.liveHandler(),
    readinessHandler: registry.readyHandler(),
    historyHandler: registry.historyHandler(),

    mount(app) {
      app.get('/internal/health/live', this.livenessHandler);
      app.get('/internal/health/ready', this.readinessHandler);
      app.get('/internal/health/history', this.historyHandler);
    },

    startScheduler() {
      scheduler.start();
      logger.info?.('health: probe scheduler started');
    },

    stopScheduler() {
      scheduler.stop();
    },
  };
}

module.exports = { createHealthSystem };
