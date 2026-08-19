'use strict';

const { randomUUID } = require('node:crypto');
const { redactErrorMessage } = require('../utils/secret-redactor');

const STRIPE_RECOVERY_LEADER_KEY = 'stripe:webhook:recovery:leader';
const STRIPE_RECOVERY_ADVISORY_LOCK_ID = 7_414_140_014;
const STRIPE_RECOVERY_LEADER_LOCK_SQL =
  'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked';
const STRIPE_PENDING_OUTBOX_SQL = `
  SELECT events."id", events."stripeEventId", due."nextDueAt"
  FROM "subscription_events" AS events
  CROSS JOIN LATERAL (
    SELECT MIN(
      CASE
        WHEN effect->>'status' = 'pending'
          THEN COALESCE(
            NULLIF(effect->>'nextAttemptAt', '')::timestamptz,
            events."processedAt"
          )
        WHEN effect->>'status' = 'processing'
          THEN COALESCE(
            NULLIF(effect->>'leaseUntil', '')::timestamptz,
            events."processedAt"
          )
        ELSE NULL
      END
    ) AS "nextDueAt"
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(events."eventData"->'outbox'->'effects') = 'array'
        THEN events."eventData"->'outbox'->'effects'
        ELSE '[]'::jsonb
      END
    ) AS effect
  ) AS due
  WHERE events."stripeEventId" IS NOT NULL
    AND due."nextDueAt" <= CURRENT_TIMESTAMP
  ORDER BY due."nextDueAt" ASC, events."processedAt" ASC, events."id" ASC
  LIMIT $1
`;
const STRIPE_PENDING_UNRESOLVED_SQL = `
  SELECT "id", "key", "value"
  FROM "system_settings"
  WHERE "key" LIKE 'stripe:webhook:unresolved:%'
    AND (
      (
        "value"::jsonb->>'status' = 'pending'
        AND (
          NULLIF("value"::jsonb->>'nextAttemptAt', '') IS NULL
          OR ("value"::jsonb->>'nextAttemptAt')::timestamptz <= CURRENT_TIMESTAMP
        )
      ) OR (
        "value"::jsonb->>'status' = 'processing'
        AND (
          NULLIF("value"::jsonb->>'leaseUntil', '') IS NULL
          OR ("value"::jsonb->>'leaseUntil')::timestamptz <= CURRENT_TIMESTAMP
        )
      )
    )
  ORDER BY "key" ASC
  LIMIT $1
`;

const DEFAULT_CONFIG = Object.freeze({
  intervalMs: 60_000,
  batchSize: 25,
  leaseMs: 120_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 60 * 60 * 1000,
  maxAttempts: 8,
});
const OUTBOX_SCAN_OVERFETCH_FACTOR = 4;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolveStripeWebhookRecoveryConfig(env = process.env) {
  const backoffBaseMs = clampInteger(
    env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS,
    DEFAULT_CONFIG.backoffBaseMs,
    1_000,
    60 * 60 * 1000,
  );
  const configuredBackoffMax = clampInteger(
    env.STRIPE_WEBHOOK_RECOVERY_BACKOFF_MAX_MS,
    DEFAULT_CONFIG.backoffMaxMs,
    1_000,
    24 * 60 * 60 * 1000,
  );
  return {
    enabled: !isTruthy(env.STRIPE_WEBHOOK_RECOVERY_DISABLED),
    intervalMs: clampInteger(
      env.STRIPE_WEBHOOK_RECOVERY_INTERVAL_MS,
      DEFAULT_CONFIG.intervalMs,
      1_000,
      60 * 60 * 1000,
    ),
    batchSize: clampInteger(
      env.STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE,
      DEFAULT_CONFIG.batchSize,
      1,
      100,
    ),
    leaseMs: clampInteger(
      env.STRIPE_WEBHOOK_RECOVERY_LEASE_MS,
      DEFAULT_CONFIG.leaseMs,
      5_000,
      15 * 60 * 1000,
    ),
    backoffBaseMs,
    backoffMaxMs: Math.max(backoffBaseMs, configuredBackoffMax),
    maxAttempts: clampInteger(
      env.STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS,
      DEFAULT_CONFIG.maxAttempts,
      1,
      25,
    ),
  };
}

function parseJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dateMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function lockWasAcquired(rows) {
  const value = rows?.[0]?.locked;
  return value === true || value === 1 || value === 't' || value === 'true';
}

function backoffMs(attempts, config) {
  const exponent = Math.max(0, Math.min(20, Number(attempts || 1) - 1));
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * (2 ** exponent));
}

function safeError(error) {
  return String(redactErrorMessage(error) || 'stripe_recovery_failed').slice(0, 500);
}

function isRecoverableMinimalEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (typeof event.id !== 'string' || !event.id.startsWith('evt_')) return false;
  if (typeof event.type !== 'string' || !event.type) return false;
  if (!event.data?.object || typeof event.data.object !== 'object') return false;
  try {
    return JSON.stringify(event).length <= 16_384;
  } catch {
    return false;
  }
}

function createStripeWebhookRecovery({
  prisma,
  processEvent,
  drainOutbox,
  env = process.env,
  logger = console,
  ownerId = randomUUID(),
  now = Date.now,
  scheduler = globalThis,
  listPendingOutboxEvents,
  listPendingUnresolvedEvents,
} = {}) {
  if (!prisma?.$transaction || !prisma?.systemSettings) {
    throw new TypeError('stripe webhook recovery requires Prisma');
  }
  if (typeof processEvent !== 'function') {
    throw new TypeError('stripe webhook recovery requires processEvent');
  }
  if (typeof drainOutbox !== 'function') {
    throw new TypeError('stripe webhook recovery requires drainOutbox');
  }
  const config = resolveStripeWebhookRecoveryConfig(env);
  const listOutbox = typeof listPendingOutboxEvents === 'function'
    ? listPendingOutboxEvents
    : async ({ limit }) => prisma.$queryRawUnsafe(STRIPE_PENDING_OUTBOX_SQL, limit);
  const listUnresolved = typeof listPendingUnresolvedEvents === 'function'
    ? listPendingUnresolvedEvents
    : async ({ limit }) => prisma.$queryRawUnsafe(STRIPE_PENDING_UNRESOLVED_SQL, limit);
  let timer = null;
  let activeRun = null;
  let running = false;
  let stopped = false;
  let lastResult = null;

  function log(level, fields, message) {
    try {
      const fn = typeof logger?.[level] === 'function' ? logger[level] : logger?.info;
      fn?.call(logger, fields, message);
    } catch {
      // Recovery and observability are intentionally isolated.
    }
  }

  async function acquireLeaderLease(nowMs) {
    return prisma.$transaction(async (tx) => {
      const lockRows = await tx.$queryRawUnsafe(
        STRIPE_RECOVERY_LEADER_LOCK_SQL,
        STRIPE_RECOVERY_ADVISORY_LOCK_ID,
      );
      if (!lockWasAcquired(lockRows)) {
        return { acquired: false, reason: 'advisory_lock_not_acquired' };
      }

      const existing = await tx.systemSettings.findUnique({
        where: { key: STRIPE_RECOVERY_LEADER_KEY },
      });
      const prior = parseJson(existing?.value);
      if (
        prior?.ownerId
        && prior.ownerId !== ownerId
        && dateMs(prior.leaseUntil) > nowMs
      ) {
        return { acquired: false, reason: 'leader_lease_held' };
      }

      const value = JSON.stringify({
        version: 1,
        ownerId,
        acquiredAt: prior?.ownerId === ownerId
          ? prior.acquiredAt || new Date(nowMs).toISOString()
          : new Date(nowMs).toISOString(),
        heartbeatAt: new Date(nowMs).toISOString(),
        leaseUntil: new Date(nowMs + config.leaseMs).toISOString(),
      });
      await tx.systemSettings.upsert({
        where: { key: STRIPE_RECOVERY_LEADER_KEY },
        create: { key: STRIPE_RECOVERY_LEADER_KEY, value },
        update: { value },
      });
      return { acquired: true };
    });
  }

  async function claimUnresolved(row, nowMs) {
    const record = parseJson(row?.value);
    if (!record || !isRecoverableMinimalEvent(record.event)) {
      if (record && record.status !== 'failed') {
        const failed = JSON.stringify({
          ...record,
          status: 'failed',
          nextAttemptAt: null,
          lastError: 'invalid_minimal_event',
        });
        await prisma.systemSettings.updateMany({
          where: { key: row.key, value: row.value },
          data: { value: failed },
        });
      }
      return null;
    }
    if (record.status === 'resolved' || record.status === 'failed') return null;
    if (
      record.status === 'processing'
      && dateMs(record.leaseUntil) > nowMs
    ) {
      return null;
    }
    const attempts = Math.max(0, Number(record.attempts || 0));
    if (attempts >= config.maxAttempts) {
      const failed = JSON.stringify({
        ...record,
        status: 'failed',
        nextAttemptAt: null,
        leaseToken: null,
        leaseUntil: null,
        lastError: record.lastError || 'max_attempts_exhausted',
      });
      await prisma.systemSettings.updateMany({
        where: { key: row.key, value: row.value },
        data: { value: failed },
      });
      return null;
    }
    if (dateMs(record.nextAttemptAt) > nowMs) return null;

    const leaseToken = randomUUID();
    const claimedRecord = {
      ...record,
      status: 'processing',
      attempts: attempts + 1,
      lastAttemptAt: new Date(nowMs).toISOString(),
      nextAttemptAt: null,
      leaseToken,
      leaseUntil: new Date(nowMs + config.leaseMs).toISOString(),
      lastError: null,
    };
    const claimedValue = JSON.stringify(claimedRecord);
    const claim = await prisma.systemSettings.updateMany({
      where: { key: row.key, value: row.value },
      data: { value: claimedValue },
    });
    if (claim.count !== 1) return null;
    return {
      key: row.key,
      claimedValue,
      record: claimedRecord,
    };
  }

  async function finishUnresolved(claim, error, nowMs) {
    const succeeded = !error;
    const terminal = !succeeded && claim.record.attempts >= config.maxAttempts;
    const next = {
      ...claim.record,
      status: succeeded ? 'resolved' : (terminal ? 'failed' : 'pending'),
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: succeeded || terminal
        ? null
        : new Date(nowMs + backoffMs(claim.record.attempts, config)).toISOString(),
      ...(succeeded
        ? {
          resolvedAt: new Date(nowMs).toISOString(),
          lastError: null,
        }
        : {
          lastFailedAt: new Date(nowMs).toISOString(),
          lastError: safeError(error),
        }),
    };
    await prisma.systemSettings.updateMany({
      where: { key: claim.key, value: claim.claimedValue },
      data: { value: JSON.stringify(next) },
    });
  }

  async function performRun() {
    if (!config.enabled) {
      return { leader: false, skipped: true, reason: 'disabled' };
    }
    const startedAt = Number(now());
    const leadership = await acquireLeaderLease(startedAt);
    if (!leadership.acquired) {
      return { leader: false, reason: leadership.reason };
    }

    const result = {
      leader: true,
      outbox: { scanned: 0, completed: 0, deferred: 0, failed: 0 },
      unresolved: { scanned: 0, resolved: 0, failed: 0 },
    };
    const outboxScanLimit = config.batchSize * OUTBOX_SCAN_OVERFETCH_FACTOR;
    const outboxRows = await listOutbox({ limit: outboxScanLimit });
    let processedOutboxRows = 0;
    for (const row of Array.isArray(outboxRows) ? outboxRows.slice(0, outboxScanLimit) : []) {
      if (processedOutboxRows >= config.batchSize) break;
      const stripeEventId = row?.stripeEventId;
      if (typeof stripeEventId !== 'string' || !stripeEventId) continue;
      result.outbox.scanned += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const drainResult = await drainOutbox(stripeEventId, {
          respectBackoff: true,
          maxAttempts: config.maxAttempts,
          backoffBaseMs: config.backoffBaseMs,
          backoffMaxMs: config.backoffMaxMs,
          now,
        });
        if (drainResult?.deferred) {
          result.outbox.deferred += 1;
        } else {
          result.outbox.completed += 1;
          processedOutboxRows += 1;
        }
      } catch (error) {
        result.outbox.failed += 1;
        processedOutboxRows += 1;
        log('warn', {
          stripeEventId,
          error: safeError(error),
        }, 'stripe_webhook_outbox_recovery_failed');
      }
    }

    const unresolvedRows = await listUnresolved({ limit: config.batchSize });
    for (const row of unresolvedRows) {
      result.unresolved.scanned += 1;
      // eslint-disable-next-line no-await-in-loop
      const claim = await claimUnresolved(row, Number(now()));
      if (!claim) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await processEvent(claim.record.event, {
          persistUnresolved: false,
          source: 'autonomous_recovery',
        });
        // eslint-disable-next-line no-await-in-loop
        await finishUnresolved(claim, null, Number(now()));
        result.unresolved.resolved += 1;
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await finishUnresolved(claim, error, Number(now()));
        result.unresolved.failed += 1;
        log('warn', {
          stripeEventId: claim.record.event.id,
          error: safeError(error),
        }, 'stripe_webhook_unresolved_recovery_failed');
      }
    }

    log('info', result, 'stripe_webhook_recovery_completed');
    return result;
  }

  function runOnce() {
    if (activeRun) return activeRun;
    activeRun = performRun()
      .then((result) => {
        lastResult = result;
        return result;
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  }

  function start() {
    if (running) return activeRun || Promise.resolve(lastResult);
    stopped = false;
    if (!config.enabled) {
      return Promise.resolve({ leader: false, skipped: true, reason: 'disabled' });
    }
    running = true;
    timer = scheduler.setInterval(() => {
      if (!stopped) void runOnce().catch((error) => {
        log('warn', { error: safeError(error) }, 'stripe_webhook_recovery_tick_failed');
      });
    }, config.intervalMs);
    timer?.unref?.();
    return runOnce();
  }

  async function stop() {
    stopped = true;
    running = false;
    if (timer) {
      scheduler.clearInterval(timer);
      timer = null;
    }
    if (activeRun) await activeRun;
  }

  function getState() {
    return {
      enabled: config.enabled,
      running,
      inFlight: Boolean(activeRun),
      ownerId,
      lastResult,
      config: { ...config },
    };
  }

  return {
    runOnce,
    start,
    stop,
    getState,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  STRIPE_RECOVERY_LEADER_KEY,
  STRIPE_RECOVERY_LEADER_LOCK_SQL,
  STRIPE_PENDING_OUTBOX_SQL,
  STRIPE_PENDING_UNRESOLVED_SQL,
  resolveStripeWebhookRecoveryConfig,
  createStripeWebhookRecovery,
};
