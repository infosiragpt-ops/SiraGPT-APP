'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STRIPE_PENDING_OUTBOX_SQL,
  STRIPE_PENDING_UNRESOLVED_SQL,
  STRIPE_RECOVERY_LEADER_KEY,
  createStripeWebhookRecovery,
  resolveStripeWebhookRecoveryConfig,
} = require('../src/services/stripe-webhook-recovery');

function clone(value) {
  return structuredClone(value);
}

function unresolvedSetting(eventId, overrides = {}) {
  return {
    id: `setting_${eventId}`,
    key: `stripe:webhook:unresolved:${eventId}`,
    value: JSON.stringify({
      version: 1,
      status: 'pending',
      attempts: 0,
      firstSeenAt: '2026-07-11T00:00:00.000Z',
      lastAttemptAt: null,
      nextAttemptAt: null,
      identifiers: {
        customerId: 'cus_recovery',
        userIdHint: null,
      },
      event: {
        id: eventId,
        type: 'customer.subscription.updated',
        created: 1_700_000_000,
        data: {
          object: {
            id: 'sub_recovery',
            customer: 'cus_recovery',
            status: 'active',
            current_period_end: 1_800_000_000,
          },
        },
      },
      ...overrides,
    }),
  };
}

function makeRecoveryPrisma({
  lockResults = [true],
  settings = [],
} = {}) {
  const state = {
    settings: clone(settings),
    lockResults: [...lockResults],
    sql: [],
    findManyArgs: [],
  };

  const systemSettings = {
    async findUnique({ where }) {
      const row = state.settings.find((entry) => entry.key === where.key);
      return row ? clone(row) : null;
    },
    async findMany(args = {}) {
      state.findManyArgs.push(clone(args));
      const prefix = args.where?.key?.startsWith;
      const rows = state.settings
        .filter((entry) => !prefix || entry.key.startsWith(prefix))
        .sort((left, right) => left.key.localeCompare(right.key))
        .slice(0, args.take);
      return clone(rows);
    },
    async upsert({ where, create, update }) {
      let row = state.settings.find((entry) => entry.key === where.key);
      if (row) Object.assign(row, clone(update));
      else {
        row = { id: `setting_${state.settings.length + 1}`, ...clone(create) };
        state.settings.push(row);
      }
      return clone(row);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of state.settings) {
        if (where.key && row.key !== where.key) continue;
        if (where.value !== undefined && row.value !== where.value) continue;
        Object.assign(row, clone(data));
        count += 1;
      }
      return { count };
    },
  };

  const db = {
    _state: state,
    systemSettings,
    async $queryRawUnsafe(sql, ...params) {
      state.sql.push({ sql, params });
      if (String(sql).includes('pg_try_advisory_xact_lock')) {
        const locked = state.lockResults.length > 0 ? state.lockResults.shift() : true;
        return [{ locked }];
      }
      if (String(sql).includes('FROM "system_settings"')) {
        return clone(
          state.settings
            .filter((row) => row.key.startsWith('stripe:webhook:unresolved:'))
            .sort((left, right) => left.key.localeCompare(right.key))
            .slice(0, params[0]),
        );
      }
      throw new Error(`unexpected raw SQL: ${sql}`);
    },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}

function captureLogger() {
  const entries = [];
  return {
    entries,
    info(fields, message) { entries.push({ level: 'info', fields, message }); },
    warn(fields, message) { entries.push({ level: 'warn', fields, message }); },
  };
}

test('recovery config is bounded and environment-controlled', () => {
  const config = resolveStripeWebhookRecoveryConfig({
    STRIPE_WEBHOOK_RECOVERY_INTERVAL_MS: '1',
    STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE: '9999',
    STRIPE_WEBHOOK_RECOVERY_LEASE_MS: '1',
    STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS: '999999999',
    STRIPE_WEBHOOK_RECOVERY_BACKOFF_MAX_MS: '2',
    STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS: '999',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.intervalMs, 1_000);
  assert.equal(config.batchSize, 100);
  assert.equal(config.leaseMs, 5_000);
  assert.equal(config.backoffBaseMs, 60 * 60 * 1000);
  assert.equal(config.backoffMaxMs, 60 * 60 * 1000);
  assert.equal(config.maxAttempts, 25);
  assert.equal(
    resolveStripeWebhookRecoveryConfig({ STRIPE_WEBHOOK_RECOVERY_DISABLED: '1' }).enabled,
    false,
  );
});

test('PostgreSQL scans select only due pending or expired leased work', () => {
  for (const sql of [STRIPE_PENDING_OUTBOX_SQL, STRIPE_PENDING_UNRESOLVED_SQL]) {
    assert.match(sql, /nextAttemptAt/);
    assert.match(sql, /leaseUntil/);
    assert.match(sql, /CURRENT_TIMESTAMP/);
    assert.match(sql, /LIMIT \$1/);
  }
  assert.match(STRIPE_PENDING_OUTBOX_SQL, /nextDueAt/);
  assert.match(STRIPE_PENDING_OUTBOX_SQL, /MIN\s*\(/);
  assert.match(STRIPE_PENDING_OUTBOX_SQL, /ORDER BY[\s\S]*nextDueAt/);
});

test('one leader performs bounded autonomous outbox and unresolved scans', async () => {
  let nowMs = Date.parse('2026-07-11T01:00:00.000Z');
  const prisma = makeRecoveryPrisma({
    settings: [
      unresolvedSetting('evt_unresolved_1'),
      unresolvedSetting('evt_unresolved_2'),
      unresolvedSetting('evt_unresolved_3'),
    ],
  });
  const outboxRows = [
    { stripeEventId: 'evt_outbox_1' },
    { stripeEventId: 'evt_outbox_2' },
    { stripeEventId: 'evt_outbox_3' },
  ];
  const listedLimits = [];
  const drained = [];
  const processed = [];
  const recovery = createStripeWebhookRecovery({
    prisma,
    env: {
      STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE: '2',
      STRIPE_WEBHOOK_RECOVERY_LEASE_MS: '5000',
    },
    ownerId: 'worker-a',
    now: () => nowMs,
    listPendingOutboxEvents: async ({ limit }) => {
      listedLimits.push(limit);
      return outboxRows.slice(0, limit);
    },
    drainOutbox: async (stripeEventId, options) => {
      drained.push({ stripeEventId, options });
    },
    processEvent: async (event, options) => {
      processed.push({ event: clone(event), options });
    },
  });

  const result = await recovery.runOnce();

  assert.equal(result.leader, true);
  assert.deepEqual(listedLimits, [8]);
  assert.deepEqual(drained.map((entry) => entry.stripeEventId), [
    'evt_outbox_1',
    'evt_outbox_2',
  ]);
  assert.ok(drained.every((entry) => entry.options.respectBackoff === true));
  assert.deepEqual(processed.map((entry) => entry.event.id), [
    'evt_unresolved_1',
    'evt_unresolved_2',
  ]);
  assert.ok(processed.every((entry) => entry.options.persistUnresolved === false));
  const unresolvedScan = prisma._state.sql.find(
    ({ sql }) => sql.includes('FROM "system_settings"'),
  );
  assert.deepEqual(unresolvedScan.params, [2]);
  assert.equal(
    JSON.parse(prisma._state.settings.find((row) => row.key.endsWith('evt_unresolved_1')).value).status,
    'resolved',
  );
  assert.ok(
    prisma._state.sql.some(({ sql }) => sql.includes('pg_try_advisory_xact_lock')),
    'leader election must use a PostgreSQL advisory lock',
  );
  assert.equal(
    JSON.parse(prisma._state.settings.find((row) => row.key === STRIPE_RECOVERY_LEADER_KEY).value).ownerId,
    'worker-a',
  );

  nowMs += 1;
});

test('deferred old rows do not count complete or starve newer due outbox work', async () => {
  const nowMs = Date.parse('2026-07-11T01:00:00.000Z');
  const prisma = makeRecoveryPrisma();
  const listedLimits = [];
  const drained = [];
  const candidates = [
    { stripeEventId: 'evt_old_deferred', nextDueAt: new Date(nowMs - 10_000) },
    { stripeEventId: 'evt_due_1', nextDueAt: new Date(nowMs - 9_000) },
    { stripeEventId: 'evt_due_2', nextDueAt: new Date(nowMs - 8_000) },
    { stripeEventId: 'evt_due_3', nextDueAt: new Date(nowMs - 7_000) },
  ];
  const recovery = createStripeWebhookRecovery({
    prisma,
    ownerId: 'worker-a',
    now: () => nowMs,
    env: {
      STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE: '2',
      STRIPE_WEBHOOK_RECOVERY_LEASE_MS: '5000',
    },
    listPendingOutboxEvents: async ({ limit }) => {
      listedLimits.push(limit);
      return candidates.slice(0, limit);
    },
    drainOutbox: async (stripeEventId) => {
      drained.push(stripeEventId);
      if (stripeEventId === 'evt_old_deferred') {
        return {
          deferred: true,
          completed: 0,
          nextAttemptAt: new Date(nowMs + 60_000).toISOString(),
        };
      }
      return { deferred: false, completed: 1 };
    },
    listPendingUnresolvedEvents: async () => [],
    processEvent: async () => {},
  });

  const result = await recovery.runOnce();

  assert.deepEqual(listedLimits, [8]);
  assert.deepEqual(drained, ['evt_old_deferred', 'evt_due_1', 'evt_due_2']);
  assert.deepEqual(result.outbox, {
    scanned: 3,
    completed: 2,
    deferred: 1,
    failed: 0,
  });
});

test('advisory-lock loser and active foreign lease perform no recovery work', async () => {
  const nowMs = Date.parse('2026-07-11T01:00:00.000Z');
  const prisma = makeRecoveryPrisma({ lockResults: [false, true] });
  const calls = [];
  const loser = createStripeWebhookRecovery({
    prisma,
    ownerId: 'worker-a',
    now: () => nowMs,
    listPendingOutboxEvents: async () => {
      calls.push('list');
      return [];
    },
    drainOutbox: async () => calls.push('drain'),
    processEvent: async () => calls.push('process'),
  });

  const notLocked = await loser.runOnce();
  assert.equal(notLocked.leader, false);
  assert.equal(notLocked.reason, 'advisory_lock_not_acquired');

  prisma._state.settings.push({
    id: 'leader',
    key: STRIPE_RECOVERY_LEADER_KEY,
    value: JSON.stringify({
      ownerId: 'worker-b',
      leaseUntil: new Date(nowMs + 60_000).toISOString(),
    }),
  });
  const leased = await loser.runOnce();
  assert.equal(leased.leader, false);
  assert.equal(leased.reason, 'leader_lease_held');
  assert.deepEqual(calls, []);
});

test('unresolved recovery uses a lease, exponential backoff, and a terminal attempt cap', async () => {
  let nowMs = Date.parse('2026-07-11T01:00:00.000Z');
  const prisma = makeRecoveryPrisma({
    settings: [unresolvedSetting('evt_backoff')],
  });
  let attempts = 0;
  const recovery = createStripeWebhookRecovery({
    prisma,
    ownerId: 'worker-a',
    now: () => nowMs,
    env: {
      STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS: '1000',
      STRIPE_WEBHOOK_RECOVERY_BACKOFF_MAX_MS: '8000',
      STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS: '2',
      STRIPE_WEBHOOK_RECOVERY_LEASE_MS: '5000',
    },
    listPendingOutboxEvents: async () => [],
    drainOutbox: async () => {},
    processEvent: async () => {
      attempts += 1;
      throw new Error(`mapping unavailable ${attempts}`);
    },
  });

  await recovery.runOnce();
  let record = JSON.parse(prisma._state.settings.find((row) => row.key.endsWith('evt_backoff')).value);
  assert.equal(record.status, 'pending');
  assert.equal(record.attempts, 1);
  assert.equal(record.leaseToken, null);
  assert.equal(record.leaseUntil, null);
  assert.equal(Date.parse(record.nextAttemptAt), nowMs + 1_000);
  assert.match(record.lastError, /mapping unavailable 1/);

  await recovery.runOnce();
  assert.equal(attempts, 1, 'backoff suppresses an immediate retry');

  nowMs += 1_000;
  await recovery.runOnce();
  record = JSON.parse(prisma._state.settings.find((row) => row.key.endsWith('evt_backoff')).value);
  assert.equal(attempts, 2);
  assert.equal(record.status, 'failed');
  assert.equal(record.attempts, 2);
  assert.equal(record.nextAttemptAt, null);

  nowMs += 60_000;
  await recovery.runOnce();
  assert.equal(attempts, 2, 'max attempts prevents an unbounded poison-record loop');
});

test('start schedules an immediate scan and stop clears the timer and awaits in-flight work', async () => {
  const prisma = makeRecoveryPrisma();
  const timers = [];
  const cleared = [];
  const scheduler = {
    setInterval(callback, delay) {
      const timer = {
        callback,
        delay,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    },
  };
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const recovery = createStripeWebhookRecovery({
    prisma,
    ownerId: 'worker-a',
    scheduler,
    env: { STRIPE_WEBHOOK_RECOVERY_INTERVAL_MS: '2000' },
    listPendingOutboxEvents: async () => [{ stripeEventId: 'evt_wait' }],
    drainOutbox: async () => blocked,
    processEvent: async () => {},
  });

  const initialRun = recovery.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 2_000);
  assert.equal(timers[0].unrefCalled, true);
  assert.equal(recovery.getState().running, true);

  let stopped = false;
  const stopPromise = recovery.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'stop waits for the active recovery scan');
  release();
  await initialRun;
  await stopPromise;

  assert.deepEqual(cleared, [timers[0]]);
  assert.equal(recovery.getState().running, false);
});

test('production lifecycle, canonical script, and operator docs wire autonomous recovery', () => {
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const envExample = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
  const rootEnvExample = fs.readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
  const environmentDocs = fs.readFileSync(
    path.resolve(__dirname, '../../docs/operations/ENVIRONMENT.md'),
    'utf8',
  );
  const standardCompose = fs.readFileSync(
    path.resolve(__dirname, '../../docker-compose.yml'),
    'utf8',
  );
  const productionCompose = fs.readFileSync(
    path.resolve(__dirname, '../../docker-compose.prod.yml'),
    'utf8',
  );
  const backendPackage = require('../package.json');
  const shutdown = require('../src/utils/shutdown');
  const startServerAt = indexSource.indexOf('async function startServer()');
  const recoveryStartAt = indexSource.indexOf('stripeWebhookRecovery.start()');

  assert.ok(recoveryStartAt > startServerAt, 'recovery starts only after production boot');
  assert.match(
    indexSource,
    /shutdownRegistry\.register\(\s*'stripe_webhook_recovery_stop'[\s\S]*?stripeWebhookRecovery\.stop\(\)/,
  );
  assert.ok(shutdown.PRODUCTION_SHUTDOWN_ORDER.includes('stripe_webhook_recovery_stop'));
  assert.ok(
    shutdown.PRODUCTION_SHUTDOWN_ORDER.indexOf('stripe_webhook_recovery_stop')
      < shutdown.PRODUCTION_SHUTDOWN_ORDER.indexOf('prisma_disconnect'),
  );
  assert.match(backendPackage.scripts.test, /tests\/stripe-webhook-recovery\.test\.js/);

  for (const name of [
    'STRIPE_WEBHOOK_RECOVERY_DISABLED',
    'STRIPE_WEBHOOK_RECOVERY_INTERVAL_MS',
    'STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE',
    'STRIPE_WEBHOOK_RECOVERY_LEASE_MS',
    'STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS',
    'STRIPE_WEBHOOK_RECOVERY_BACKOFF_MAX_MS',
    'STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS',
  ]) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
    assert.match(rootEnvExample, new RegExp(`^${name}=`, 'm'));
    assert.match(environmentDocs, new RegExp(`\\| \\\`${name}\\\` \\|`));
    assert.match(standardCompose, new RegExp(`^\\s+${name}:`, 'm'));
    assert.match(productionCompose, new RegExp(`^\\s+${name}:`, 'm'));
  }
});
