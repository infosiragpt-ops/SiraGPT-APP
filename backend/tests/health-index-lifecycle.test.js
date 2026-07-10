'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const indexSource = fs.readFileSync(require.resolve('../index.js'), 'utf8');
const backendPackage = require('../package.json');
const productionCompose = fs.readFileSync(
  path.resolve(__dirname, '../../docker-compose.prod.yml'),
  'utf8',
);
const standardCompose = fs.readFileSync(
  path.resolve(__dirname, '../../docker-compose.yml'),
  'utf8',
);

test('index mounts internal health beside the unchanged public health routes', () => {
  assert.match(indexSource, /const\s+\{\s*createHealthSystem\s*\}\s*=\s*require\('\.\/src\/health\/mount'\)/);
  assert.match(indexSource, /healthRoutes\.register\(app\)/);
  assert.match(indexSource, /internalHealthSystem\.mount\(app\)/);
});

test('index reuses the public health route Redis client and logger', () => {
  const construction = indexSource.match(
    /const\s+internalHealthSystem\s*=\s*createHealthSystem\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(construction, 'internal health system must be constructed');
  assert.match(construction[1], /prisma/);
  assert.match(construction[1], /healthRoutes\.getHealthRedisClient\(\)/);
  assert.match(construction[1], /logger/);
  assert.doesNotMatch(construction[1], /new\s+IORedis|require\(['"]ioredis['"]\)/);
});

test('internal probe scheduler starts only inside startServer', () => {
  const startServerAt = indexSource.indexOf('async function startServer()');
  const schedulerStartAt = indexSource.indexOf('internalHealthSystem.startScheduler()');
  assert.ok(startServerAt >= 0, 'startServer must exist');
  assert.ok(schedulerStartAt > startServerAt, 'scheduler must start from startServer, never at module import');
  assert.doesNotMatch(indexSource.slice(0, startServerAt), /internalHealthSystem\.startScheduler\(\)/);
});

test('queue metric refresh scheduler starts and stops with the server lifecycle', () => {
  const startServerAt = indexSource.indexOf('async function startServer()');
  const queueRefreshStartAt = indexSource.indexOf('defaultQueueHealthProbe.start()');
  assert.ok(queueRefreshStartAt > startServerAt, 'queue refresh must start only inside startServer');
  assert.doesNotMatch(
    indexSource.slice(0, startServerAt),
    /defaultQueueHealthProbe\.start\(\)/,
  );

  const schedulerStop = indexSource.match(
    /shutdownRegistry\.register\(\s*'scheduler_stop',\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*5000,?\s*\);/,
  );
  assert.ok(schedulerStop, 'scheduler_stop shutdown phase must remain registered');
  assert.match(schedulerStop[1], /defaultQueueHealthProbe\.stop\(\)/);
});

test('shared Prisma pool instrumentation feeds full health and Prometheus metrics', () => {
  const healthConstruction = indexSource.match(
    /const\s+healthRoutes\s*=\s*createHealthRoutes\(\{([\s\S]*?)\}\);/,
  );
  assert.ok(healthConstruction, 'health routes must be constructed');
  assert.match(healthConstruction[1], /poolMetrics:\s*prisma\.poolMetrics/);
  assert.match(healthConstruction[1], /getPoolAutoscalerState/);
  assert.match(indexSource, /configureDatabasePoolMetrics\(\{/);
  assert.match(indexSource, /snapshot:\s*\(\)\s*=>\s*prisma\.poolMetrics\.snapshot\(\)/);
  assert.match(indexSource, /recommendation:\s*getPoolAutoscalerState/);
});

test('advisory database pool autoscaler starts only in startServer and never receives apply', () => {
  const startServerAt = indexSource.indexOf('async function startServer()');
  const autoscalerStartAt = indexSource.indexOf('startDatabasePoolAutoscaler();');
  assert.ok(startServerAt >= 0, 'startServer must exist');
  assert.ok(autoscalerStartAt > startServerAt, 'autoscaler must start from startServer');
  assert.doesNotMatch(indexSource.slice(0, startServerAt), /startDatabasePoolAutoscaler\(\);/);
  assert.match(indexSource, /DATABASE_POOL_AUTOSCALE_ENABLED/);
  assert.match(indexSource, /capacity\?\.observable\s*===\s*false/);
  assert.match(
    indexSource,
    /createPoolAutoscaler\(\{\s*metrics:\s*prisma\.poolMetrics,/,
  );
  assert.doesNotMatch(
    indexSource,
    /createPoolAutoscaler\(\{[\s\S]{0,800}?\bapply\s*:/,
    'production autoscaler must remain recommendation-only',
  );
});

test('production shutdown stops the advisory pool autoscaler', () => {
  assert.match(
    indexSource,
    /shutdownRegistry\.register\(\s*'database_pool_autoscaler_stop',[\s\S]*?poolAutoscaler\?\.stop\(\)/,
  );
  const order = require('../src/utils/shutdown').PRODUCTION_SHUTDOWN_ORDER;
  assert.ok(order.includes('database_pool_autoscaler_stop'));
  assert.ok(
    order.indexOf('database_pool_autoscaler_stop') < order.indexOf('prisma_disconnect'),
    'autoscaler must stop before Prisma disconnects',
  );
});

test('first shutdown phase stops both schedulers before other teardown', () => {
  const hook = indexSource.match(
    /shutdownRegistry\.register\(\s*'scheduler_stop',\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*5000,?\s*\);/,
  );
  assert.ok(hook, 'scheduler_stop shutdown phase must remain registered');
  assert.match(hook[1], /internalHealthSystem\.stopScheduler\(\)/);
  assert.match(hook[1], /scheduler\.stop\?\.\(\)/);

  const schedulerOrder = require('../src/utils/shutdown').PRODUCTION_SHUTDOWN_ORDER;
  assert.equal(schedulerOrder[0], 'scheduler_stop');
});

test('canonical backend scripts explicitly register every focused health suite', () => {
  for (const scriptName of ['test', 'test:health']) {
    const command = backendPackage.scripts[scriptName];
    for (const file of [
      'tests/sira-health-and-metrics.test.js',
      'tests/probe-scheduler.test.js',
      'tests/health-mount.test.js',
      'tests/health-index-lifecycle.test.js',
    ]) {
      assert.match(command, new RegExp(`(?:^|\\s)${file.replaceAll('.', '\\.')}(?:\\s|$)`));
    }
  }
});

test('standard and production Docker backends pass through every operational control', () => {
  const expected = {
    INTERNAL_HEALTH_TOKEN: '',
    INTERNAL_HEALTH_ALLOW_LOOPBACK: 'false',
    METRICS_TOKEN: '',
    METRICS_ALLOW_LOOPBACK: 'false',
    HEALTH_CACHE_TTL_MS: '5000',
    HEALTH_DB_TIMEOUT_MS: '1500',
    HEALTH_PROBE_INTERVAL_MS: '30000',
    HEALTH_PROVIDER_PROBES_ENABLED: 'false',
    HEALTH_SCHEDULE_PROVIDER_PROBES: 'false',
    HEALTH_QUEUE_PROBE_TIMEOUT_MS: '1500',
    HEALTH_QUEUE_PROBE_CACHE_TTL_MS: '1000',
    HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS: '30000',
    HEALTH_CRITICAL_QUEUES: '',
    DATABASE_POOL_MIN: '2',
    DATABASE_POOL_MAX: '10',
    DATABASE_POOL_TIMEOUT_MS: '10000',
    DATABASE_POOL_AUTOSCALE_ENABLED: 'false',
    DATABASE_POOL_AUTOSCALE_INTERVAL_MS: '30000',
    DATABASE_POOL_AUTOSCALE_MIN: '2',
    DATABASE_POOL_AUTOSCALE_MAX: '50',
    DATABASE_POOL_AUTOSCALE_COLD_SAMPLES: '3',
  };
  const missing = [];
  for (const [composeName, compose] of [
    ['docker-compose.prod.yml', productionCompose],
    ['docker-compose.yml', standardCompose],
  ]) {
    const backendBlock = compose.match(/\n  backend:\n([\s\S]*?)(?=\n  frontend:\n)/);
    assert.ok(backendBlock, `expected backend service in ${composeName}`);
    for (const [name, fallback] of Object.entries(expected)) {
      const escapedFallback = fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const passthrough = new RegExp(
        `${name}:\\s+["']?\\$\\{${name}:-${escapedFallback}\\}["']?`,
      );
      if (!passthrough.test(backendBlock[1])) missing.push(`${composeName}:${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
