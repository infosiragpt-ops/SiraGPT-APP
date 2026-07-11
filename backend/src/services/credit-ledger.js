'use strict';

const { randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { sha256Hex } = require('../utils/canonical-json');

const IDEMPOTENCY_PREFIX = 'credit-idem:v1:';
const MAX_CACHED_RESPONSE_BYTES = 512 * 1024;
const TERMINAL_STATES = new Set(['completed', 'failed', 'refunded']);
const DEFAULT_IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;
const MIN_IDEMPOTENCY_LEASE_MS = 5 * 1000;
const MAX_IDEMPOTENCY_LEASE_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_LEASE_BUFFER_MS = 30 * 1000;

function resolveIdempotencyLeaseMs(env = process.env) {
  const parsed = Number.parseInt(env.CREDIT_IDEMPOTENCY_LEASE_MS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const imageTimeout = Number.parseInt(env.IMAGE_GEN_TIMEOUT_MS || '', 10);
    const paraphraseTimeout = Number.parseInt(
      env.PARAPHRASE_PROVIDER_TIMEOUT_MS || '',
      10,
    );
    const providerTimeout = Math.max(
      Number.isFinite(imageTimeout) && imageTimeout > 0
        ? Math.min(
          MAX_IDEMPOTENCY_LEASE_MS - PROVIDER_TIMEOUT_LEASE_BUFFER_MS,
          imageTimeout,
        )
        : 120_000,
      Number.isFinite(paraphraseTimeout) && paraphraseTimeout > 0
        ? Math.min(
          MAX_IDEMPOTENCY_LEASE_MS - PROVIDER_TIMEOUT_LEASE_BUFFER_MS,
          paraphraseTimeout,
        )
        : 15_000,
    );
    return Math.min(
      MAX_IDEMPOTENCY_LEASE_MS,
      Math.max(
        MIN_IDEMPOTENCY_LEASE_MS,
        DEFAULT_IDEMPOTENCY_LEASE_MS,
        providerTimeout + PROVIDER_TIMEOUT_LEASE_BUFFER_MS,
      ),
    );
  }
  return Math.min(MAX_IDEMPOTENCY_LEASE_MS, Math.max(MIN_IDEMPOTENCY_LEASE_MS, parsed));
}

function clampIdempotencyLeaseMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return resolveIdempotencyLeaseMs();
  return Math.min(MAX_IDEMPOTENCY_LEASE_MS, Math.max(MIN_IDEMPOTENCY_LEASE_MS, Math.trunc(parsed)));
}

function validDate(value, fallback = new Date()) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : fallback;
}

function supportsRawLedgerClient(client) {
  return Boolean(
    client
    && typeof client.$transaction === 'function'
    && typeof client.$queryRaw === 'function',
  );
}

function supportsRawTransaction(tx) {
  return Boolean(tx && typeof tx.$queryRaw === 'function');
}

function hashIdempotencyKey(userId, rawKey) {
  const user = String(userId || '').trim();
  const key = String(rawKey || '').trim();
  if (!user || !key) return null;
  return `${IDEMPOTENCY_PREFIX}${sha256Hex({
    namespace: 'credit_transactions',
    userId: user,
    key,
  })}`;
}

function generatedOperationKey() {
  return `server:${randomUUID()}`;
}

function generatedTransactionId(kind = 'credit') {
  return `${kind}_${randomUUID()}`;
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function jsonStringify(value) {
  return JSON.stringify(value, (_key, entry) => (
    typeof entry === 'bigint' ? entry.toString() : entry
  ));
}

function jsonSafeResponse(body) {
  const serialized = jsonStringify(body);
  if (serialized === undefined) {
    const error = new TypeError('idempotent response body must be JSON serializable');
    error.code = 'IDEMPOTENCY_RESPONSE_INVALID';
    throw error;
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHED_RESPONSE_BYTES) {
    const error = new RangeError('idempotent response exceeds cache limit');
    error.code = 'IDEMPOTENCY_RESPONSE_TOO_LARGE';
    throw error;
  }
  return JSON.parse(serialized);
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) return fallback;
  try {
    return BigInt(typeof value === 'number' ? Math.trunc(value) : value);
  } catch {
    return fallback;
  }
}

function normalizeRequestedAmount(value) {
  if (typeof value === 'bigint') return value > 0n ? value : null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return BigInt(Math.ceil(numeric));
}

function normalizeLedgerRow(row) {
  if (!row) return null;
  return {
    ...row,
    amount: toBigInt(row.amount),
    balanceAfter: toBigInt(row.balanceAfter),
    metadata: parseMetadata(row.metadata),
  };
}

function buildIdentity({
  userId,
  amount,
  feature,
  idempotencyKey,
  requestId,
  requestHash,
}) {
  const requestedAmount = normalizeRequestedAmount(amount);
  const user = String(userId || '').trim();
  const operationKey = String(idempotencyKey || requestId || generatedOperationKey()).trim();
  const featureName = String(feature || '').trim();
  const bodyHash = String(requestHash || '').trim();
  if (!user || !requestedAmount || !featureName || !operationKey || !bodyHash) return null;
  return {
    userId: user,
    requestedAmount,
    feature: featureName,
    requestHash: bodyHash,
    idempotencyKeyHash: hashIdempotencyKey(user, operationKey),
  };
}

function stateOf(row) {
  return parseMetadata(row?.metadata).idempotency?.state || 'in_progress';
}

function leaseTokenOf(row) {
  const value = parseMetadata(row?.metadata).idempotency?.leaseToken;
  return typeof value === 'string' && value ? value : null;
}

function leaseUntilOf(row, leaseMs = resolveIdempotencyLeaseMs()) {
  const metadata = parseMetadata(row?.metadata);
  const idempotency = parseMetadata(metadata.idempotency);
  const explicit = Date.parse(idempotency.leaseUntil || '');
  if (Number.isFinite(explicit)) return new Date(explicit);
  const started = Date.parse(idempotency.startedAt || '');
  if (Number.isFinite(started)) return new Date(started + clampIdempotencyLeaseMs(leaseMs));
  const created = row?.createdAt instanceof Date
    ? row.createdAt.getTime()
    : Date.parse(row?.createdAt || '');
  return Number.isFinite(created)
    ? new Date(created + clampIdempotencyLeaseMs(leaseMs))
    : new Date(0);
}

function nextLeaseMetadata(previous, now, leaseMs, { recovered = false } = {}) {
  const start = validDate(now);
  const prior = parseMetadata(previous);
  const leaseUntil = new Date(start.getTime() + clampIdempotencyLeaseMs(leaseMs));
  return {
    ...prior,
    state: 'in_progress',
    response: null,
    startedAt: start.toISOString(),
    leaseUntil: leaseUntil.toISOString(),
    leaseToken: randomUUID(),
    recoveryCount: Math.max(0, Number(prior.recoveryCount) || 0) + (recovered ? 1 : 0),
    ...(recovered ? { recoveredAt: start.toISOString() } : {}),
  };
}

function leaseMatches(current, transaction) {
  const currentToken = leaseTokenOf(current);
  const suppliedToken = leaseTokenOf(transaction);
  return Boolean(currentToken && suppliedToken && currentToken === suppliedToken);
}

function cachedResponseOf(row) {
  const idempotency = parseMetadata(row?.metadata).idempotency;
  const response = idempotency?.response;
  if (
    idempotency?.state !== 'completed'
    || !response
    || !Number.isInteger(response.statusCode)
    || !Object.prototype.hasOwnProperty.call(response, 'body')
  ) {
    return null;
  }
  return {
    statusCode: response.statusCode,
    body: response.body,
  };
}

function identityMatches(row, identity) {
  if (!row || !identity) return false;
  const metadata = parseMetadata(row.metadata);
  return row.userId === identity.userId
    && row.idempotencyKey === identity.idempotencyKeyHash
    && metadata.feature === identity.feature
    && metadata.requestHash === identity.requestHash
    && String(metadata.requestedAmount) === identity.requestedAmount.toString();
}

function existingReservationResult(row, identity) {
  const existing = normalizeLedgerRow(row);
  if (!identityMatches(existing, identity)) {
    return {
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
      existingTransactionId: existing?.id || null,
    };
  }
  const state = stateOf(existing);
  if (state === 'completed') {
    const cachedResponse = cachedResponseOf(existing);
    if (cachedResponse) {
      return {
        ok: true,
        replay: true,
        winner: false,
        txn: existing,
        cachedResponse,
        path: existing.metadata.path,
      };
    }
    return {
      ok: false,
      code: 'IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE',
      retryable: false,
      existingTransactionId: existing.id,
    };
  }
  const codeByState = {
    failed: 'IDEMPOTENCY_FAILED',
    refunded: 'IDEMPOTENCY_REFUNDED',
    refund_pending: 'IDEMPOTENCY_REFUND_PENDING',
    in_progress: 'IDEMPOTENCY_IN_PROGRESS',
  };
  return {
    ok: false,
    code: codeByState[state] || 'IDEMPOTENCY_IN_PROGRESS',
    retryable: true,
    existingTransactionId: existing.id,
    ...(state === 'refund_pending' ? { txn: existing, path: existing.metadata.path } : {}),
  };
}

async function lockOperation(tx, idempotencyKeyHash) {
  return tx.$queryRaw(Prisma.sql`
    /* credit-ledger:lock-operation */
    SELECT pg_advisory_xact_lock(hashtext(${idempotencyKeyHash})) AS locked
  `);
}

async function selectByKey(tx, idempotencyKeyHash) {
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:select-by-key */
    SELECT
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
    FROM "credit_transactions"
    WHERE "idempotencyKey" = ${idempotencyKeyHash}
    LIMIT 1
    FOR UPDATE
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

async function selectByIdForUpdate(tx, id, userId) {
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:select-by-id */
    SELECT
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
    FROM "credit_transactions"
    WHERE "id" = ${id}
      AND "userId" = ${userId}
    FOR UPDATE
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

async function selectRefundByOriginalTransaction(tx, userId, originalTransactionId) {
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:select-refund-by-original */
    SELECT
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
    FROM "credit_transactions"
    WHERE "userId" = ${userId}
      AND "type" = 'REFUND'
      AND (
        "metadata"->>'refundedTxnId' = ${originalTransactionId}
        OR "metadata"->>'transactionId' = ${originalTransactionId}
      )
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

async function insertTransaction(tx, {
  id,
  userId,
  orgId = null,
  type,
  amount,
  balanceAfter,
  reason,
  metadata,
  idempotencyKey,
  createdAt,
}) {
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:insert-transaction */
    INSERT INTO "credit_transactions" (
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
    )
    VALUES (
      ${id},
      ${userId},
      ${orgId},
      ${type}::"CreditTransactionType",
      ${amount.toString()}::BIGINT,
      ${balanceAfter.toString()}::BIGINT,
      ${reason},
      ${jsonStringify(metadata)}::JSONB,
      ${idempotencyKey},
      ${createdAt}
    )
    RETURNING
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

async function updateOwnedMetadata(tx, row, metadata, {
  expectedState,
  leaseToken,
} = {}) {
  if (!row?.id || !row?.userId || !expectedState || !leaseToken) return null;
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:update-owned-metadata */
    UPDATE "credit_transactions"
    SET "metadata" = ${jsonStringify(metadata)}::JSONB
    WHERE "id" = ${row.id}
      AND "userId" = ${row.userId}
      AND "metadata"->'idempotency'->>'state' = ${expectedState}
      AND "metadata"->'idempotency'->>'leaseToken' = ${leaseToken}
    RETURNING
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

async function updateLegacyRefundMetadata(tx, row, metadata, legacyRefundSource) {
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:legacy-refund-cas */
    UPDATE "credit_transactions"
    SET "metadata" = ${jsonStringify(metadata)}::JSONB
    WHERE "id" = ${row.id}
      AND "userId" = ${row.userId}
      AND "type" = 'SPEND'
      AND "amount" < 0
      AND (
        (
          ${legacyRefundSource} = 'pre_fencing'
          AND "metadata"->>'path' = 'paid'
          AND "metadata"->'idempotency'->>'state' = 'completed'
          AND "metadata"->'idempotency'->>'leaseToken' IS NULL
        )
        OR (
          ${legacyRefundSource} = 'pre_idempotency'
          AND NOT (COALESCE("metadata", '{}'::JSONB) ? 'idempotency')
        )
      )
    RETURNING
      "id", "userId", "orgId", "type", "amount", "balanceAfter",
      "reason", "metadata", "idempotencyKey", "createdAt"
  `);
  return normalizeLedgerRow(Array.isArray(rows) ? rows[0] : null);
}

function leaseLostResult(row) {
  return {
    ok: false,
    code: 'LEASE_LOST',
    retryable: true,
    existingTransactionId: row?.id || null,
  };
}

async function heartbeatLedgerLease({
  prismaClient,
  transaction,
  leaseMs,
  now = new Date(),
}) {
  requireClient(prismaClient);
  if (!transaction?.id || !transaction?.userId) {
    return { ok: false, code: 'NO_TXN' };
  }
  return prismaClient.$transaction(async (tx) => {
    const current = await selectByIdForUpdate(tx, transaction.id, transaction.userId);
    if (!current || current.idempotencyKey !== transaction.idempotencyKey) {
      return leaseLostResult(current);
    }
    if (stateOf(current) !== 'in_progress' || !leaseMatches(current, transaction)) {
      return leaseLostResult(current);
    }
    const heartbeatAt = validDate(now);
    const durationMs = clampIdempotencyLeaseMs(
      leaseMs || current.metadata.idempotency?.leaseMs,
    );
    const metadata = {
      ...current.metadata,
      idempotency: {
        ...parseMetadata(current.metadata.idempotency),
        leaseMs: durationMs,
        leaseUntil: new Date(heartbeatAt.getTime() + durationMs).toISOString(),
        heartbeatAt: heartbeatAt.toISOString(),
      },
    };
    const updated = await updateOwnedMetadata(tx, current, metadata, {
      expectedState: 'in_progress',
      leaseToken: leaseTokenOf(transaction),
    });
    if (!updated) return leaseLostResult(current);
    return { ok: true, txn: updated };
  });
}

async function attachLedgerResource({
  prismaClient,
  transaction,
  resourceType,
  resourceId,
  resourceSpec,
}) {
  requireClient(prismaClient);
  const type = String(resourceType || '').trim();
  const id = String(resourceId || '').trim();
  if (!transaction?.id || !transaction?.userId || type !== 'generatedImage' || !id) {
    return { ok: false, code: 'INVALID_RESOURCE' };
  }
  return prismaClient.$transaction(async (tx) => {
    const current = await selectByIdForUpdate(tx, transaction.id, transaction.userId);
    if (!current || current.idempotencyKey !== transaction.idempotencyKey) {
      return leaseLostResult(current);
    }
    if (stateOf(current) !== 'in_progress' || !leaseMatches(current, transaction)) {
      return leaseLostResult(current);
    }
    if (current.metadata.resourceId || current.metadata.resourceType) {
      if (
        current.metadata.resourceId === id
        && current.metadata.resourceType === type
      ) {
        return { ok: true, replay: true, txn: current };
      }
      return {
        ok: false,
        code: 'IDEMPOTENCY_RESOURCE_CONFLICT',
        existingResourceId: current.metadata.resourceId || null,
      };
    }
    const metadata = {
      ...current.metadata,
      resourceType: type,
      resourceId: id,
      ...(resourceSpec && typeof resourceSpec === 'object' && !Array.isArray(resourceSpec)
        ? { resourceSpec: parseMetadata(resourceSpec) }
        : {}),
      resourceAttachedAt: new Date().toISOString(),
    };
    const updated = await updateOwnedMetadata(tx, current, metadata, {
      expectedState: 'in_progress',
      leaseToken: leaseTokenOf(transaction),
    });
    if (!updated) return leaseLostResult(current);
    return { ok: true, txn: updated };
  });
}

function startLedgerLeaseHeartbeat({
  prismaClient,
  transaction,
  leaseMs,
  intervalMs,
  heartbeat = heartbeatLedgerLease,
  onLeaseLost,
  onError,
} = {}) {
  const durationMs = clampIdempotencyLeaseMs(
    leaseMs || transaction?.metadata?.idempotency?.leaseMs,
  );
  const safelyBelowExpiry = Math.max(1, Math.floor(durationMs / 3));
  const requestedInterval = Number(intervalMs);
  const heartbeatIntervalMs = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? Math.min(safelyBelowExpiry, Math.max(1, Math.trunc(requestedInterval)))
    : Math.min(30_000, Math.max(1_000, safelyBelowExpiry));
  let stopped = false;
  let inFlight = null;
  let leaseLost = false;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = Promise.resolve(heartbeat({
      prismaClient,
      transaction,
      leaseMs: durationMs,
    }))
      .then((result) => {
        if (result?.code !== 'LEASE_LOST') return;
        leaseLost = true;
        stopped = true;
        clearInterval(timer);
        try {
          onLeaseLost?.(result);
        } catch {
          // A consumer callback must never create an unhandled timer rejection.
        }
      })
      .catch((error) => {
        try {
          onError?.(error);
        } catch {
          // Heartbeat telemetry is best-effort; the next tick can retry.
        }
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, heartbeatIntervalMs);
  timer.unref?.();
  return {
    timer,
    intervalMs: heartbeatIntervalMs,
    get leaseLost() {
      return leaseLost;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    },
  };
}

async function claimExistingReservation(tx, row, identity, {
  now = new Date(),
  leaseMs = resolveIdempotencyLeaseMs(),
} = {}) {
  const existing = normalizeLedgerRow(row);
  if (!identityMatches(existing, identity)) {
    return existingReservationResult(existing, identity);
  }
  const state = stateOf(existing);
  if (state !== 'in_progress') {
    return existingReservationResult(existing, identity);
  }

  const operationNow = validDate(now);
  const leaseUntil = leaseUntilOf(existing, leaseMs);
  if (operationNow.getTime() < leaseUntil.getTime()) {
    return {
      ok: false,
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
      existingTransactionId: existing.id,
      leaseUntil: leaseUntil.toISOString(),
    };
  }

  const priorLeaseToken = leaseTokenOf(existing);
  if (!priorLeaseToken) return leaseLostResult(existing);
  const metadata = {
    ...existing.metadata,
    idempotency: nextLeaseMetadata(
      existing.metadata.idempotency,
      operationNow,
      leaseMs,
      { recovered: true },
    ),
  };
  const updated = await updateOwnedMetadata(tx, existing, metadata, {
    expectedState: 'in_progress',
    leaseToken: priorLeaseToken,
  });
  if (!updated) return leaseLostResult(existing);
  return {
    ok: true,
    replay: false,
    recovered: true,
    winner: false,
    ownsLease: true,
    path: updated.metadata.path,
    txn: updated,
    identity,
  };
}

function initialMetadata({
  metadata,
  identity,
  path,
  now,
  leaseMs,
}) {
  return {
    ...parseMetadata(metadata),
    feature: identity.feature,
    requestHash: identity.requestHash,
    requestedAmount: identity.requestedAmount.toString(),
    path,
    idempotency: nextLeaseMetadata({}, now, leaseMs),
  };
}

function requireClient(prismaClient) {
  if (!prismaClient || typeof prismaClient.$transaction !== 'function') {
    const error = new Error('credit ledger transaction client unavailable');
    error.code = 'CREDIT_LEDGER_UNAVAILABLE';
    throw error;
  }
}

async function reservePaidCharge({
  prismaClient,
  userId,
  amount,
  feature,
  reason,
  metadata,
  idempotencyKey,
  requestId,
  requestHash,
  now = new Date(),
  leaseMs = resolveIdempotencyLeaseMs(),
}) {
  requireClient(prismaClient);
  const identity = buildIdentity({
    userId,
    amount,
    feature,
    idempotencyKey,
    requestId,
    requestHash,
  });
  if (!identity) return { ok: false, code: 'INVALID_AMOUNT' };

  return prismaClient.$transaction(async (tx) => {
    if (!supportsRawTransaction(tx)) {
      const error = new Error('credit ledger raw transaction API unavailable');
      error.code = 'CREDIT_LEDGER_UNAVAILABLE';
      throw error;
    }
    await lockOperation(tx, identity.idempotencyKeyHash);
    const existing = await selectByKey(tx, identity.idempotencyKeyHash);
    if (existing) {
      return claimExistingReservation(tx, existing, identity, { now, leaseMs });
    }

    const rows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:guarded-debit */
      UPDATE "credits"
      SET
        "balance" = "balance" - ${identity.requestedAmount.toString()}::BIGINT,
        "lifetimeSpent" = "lifetimeSpent" + ${identity.requestedAmount.toString()}::BIGINT,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = ${identity.userId}
        AND "balance" >= ${identity.requestedAmount.toString()}::BIGINT
      RETURNING "balance", "orgId"
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, code: 'INSUFFICIENT' };
    }
    const balanceAfter = toBigInt(rows[0].balance);
    const txn = await insertTransaction(tx, {
      id: generatedTransactionId('credit'),
      userId: identity.userId,
      orgId: rows[0].orgId || null,
      type: 'SPEND',
      amount: -identity.requestedAmount,
      balanceAfter,
      reason: reason || `spend(${identity.feature})`,
      metadata: initialMetadata({
        metadata,
        identity,
        path: 'paid',
        now,
        leaseMs,
      }),
      idempotencyKey: identity.idempotencyKeyHash,
      createdAt: now,
    });
    return {
      ok: true,
      replay: false,
      winner: true,
      ownsLease: true,
      path: 'paid',
      txn,
      identity,
    };
  });
}

async function reserveFallbackCharge({
  prismaClient,
  userId,
  amount,
  feature,
  reason,
  metadata,
  idempotencyKey,
  requestId,
  requestHash,
  dailyLimit,
  windowStart,
  windowEnd,
  now = new Date(),
  leaseMs = resolveIdempotencyLeaseMs(),
}) {
  requireClient(prismaClient);
  const identity = buildIdentity({
    userId,
    amount,
    feature,
    idempotencyKey,
    requestId,
    requestHash,
  });
  const limit = Number(dailyLimit);
  if (
    !identity
    || !Number.isSafeInteger(limit)
    || limit <= 0
    || !(windowStart instanceof Date)
    || !(windowEnd instanceof Date)
  ) {
    return { ok: false, code: 'FALLBACK_QUOTA_UNAVAILABLE', retryable: true };
  }

  return prismaClient.$transaction(async (tx) => {
    if (!supportsRawTransaction(tx)) {
      const error = new Error('credit ledger raw transaction API unavailable');
      error.code = 'CREDIT_LEDGER_UNAVAILABLE';
      throw error;
    }
    await lockOperation(tx, identity.idempotencyKeyHash);
    const existing = await selectByKey(tx, identity.idempotencyKeyHash);
    if (existing) {
      return claimExistingReservation(tx, existing, identity, { now, leaseMs });
    }

    const quotaLockKey = `free-ia:${identity.userId}:${windowStart.toISOString()}`;
    await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:lock-fallback-quota */
      SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey})) AS locked
    `);
    const countRows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:count-fallback */
      SELECT COUNT(*)::INT AS "used"
      FROM "credit_transactions"
      WHERE "userId" = ${identity.userId}
        AND "createdAt" >= ${windowStart}
        AND "createdAt" < ${windowEnd}
        AND "metadata"->>'path' = 'free_ia'
    `);
    const used = Number(countRows?.[0]?.used || 0);
    if (used >= limit) {
      return {
        ok: false,
        code: 'FALLBACK_QUOTA_EXCEEDED',
        limit,
        used,
      };
    }

    const balanceRows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:read-balance */
      SELECT "balance", "orgId"
      FROM "credits"
      WHERE "userId" = ${identity.userId}
      FOR SHARE
    `);
    const balanceAfter = toBigInt(balanceRows?.[0]?.balance);
    const txn = await insertTransaction(tx, {
      id: generatedTransactionId('credit'),
      userId: identity.userId,
      orgId: balanceRows?.[0]?.orgId || null,
      type: 'SPEND',
      amount: 0n,
      balanceAfter,
      reason: reason || `fallback(${identity.feature})`,
      metadata: initialMetadata({
        metadata,
        identity,
        path: 'free_ia',
        now,
        leaseMs,
      }),
      idempotencyKey: identity.idempotencyKeyHash,
      createdAt: now,
    });
    return {
      ok: true,
      replay: false,
      winner: true,
      ownsLease: true,
      path: 'free_ia',
      txn,
      identity,
      limit,
      used: used + 1,
    };
  });
}

async function ensureCreditRowTx(tx, userId, now = new Date()) {
  const id = generatedTransactionId('credit_balance');
  const rows = await tx.$queryRaw(Prisma.sql`
    /* credit-ledger:ensure-credit-row */
    WITH inserted AS (
      INSERT INTO "credits" (
        "id", "userId", "balance", "reservedBalance",
        "lifetimeGranted", "lifetimeSpent", "createdAt", "updatedAt"
      )
      VALUES (
        ${id}, ${userId}, 0, 0, 0, 0, ${now}, ${now}
      )
      ON CONFLICT ("userId") DO NOTHING
      RETURNING
        "id", "userId", "orgId", "balance", "reservedBalance",
        "lifetimeGranted", "lifetimeSpent", "lastRefillAt",
        "nextRefillAt", "createdAt", "updatedAt"
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT
      "id", "userId", "orgId", "balance", "reservedBalance",
      "lifetimeGranted", "lifetimeSpent", "lastRefillAt",
      "nextRefillAt", "createdAt", "updatedAt"
    FROM "credits"
    WHERE "userId" = ${userId}
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    const error = new Error('credit balance row unavailable');
    error.code = 'CREDIT_ROW_UNAVAILABLE';
    throw error;
  }
  return {
    ...row,
    balance: toBigInt(row.balance),
    reservedBalance: toBigInt(row.reservedBalance),
    lifetimeGranted: toBigInt(row.lifetimeGranted),
    lifetimeSpent: toBigInt(row.lifetimeSpent),
  };
}

async function ensureCreditBalanceRow({
  prismaClient,
  userId,
  now = new Date(),
}) {
  requireClient(prismaClient);
  const user = String(userId || '').trim();
  if (!user) throw new TypeError('userId is required');
  return prismaClient.$transaction(async (tx) => ensureCreditRowTx(tx, user, now));
}

async function getCreditBalanceRow({
  prismaClient,
  userId,
}) {
  requireClient(prismaClient);
  const user = String(userId || '').trim();
  if (!user) return null;
  return prismaClient.$transaction(async (tx) => {
    const rows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:get-credit-row */
      SELECT
        "id", "userId", "orgId", "balance", "reservedBalance",
        "lifetimeGranted", "lifetimeSpent", "lastRefillAt",
        "nextRefillAt", "createdAt", "updatedAt"
      FROM "credits"
      WHERE "userId" = ${user}
      LIMIT 1
    `);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row
      ? {
          ...row,
          balance: toBigInt(row.balance),
          reservedBalance: toBigInt(row.reservedBalance),
          lifetimeGranted: toBigInt(row.lifetimeGranted),
          lifetimeSpent: toBigInt(row.lifetimeSpent),
        }
      : null;
  });
}

async function reserveCreditGrant({
  prismaClient,
  userId,
  amount,
  type = 'ADMIN_ADJUSTMENT',
  reason,
  metadata,
  idempotencyKey,
  requestId,
  requestHash,
  now = new Date(),
  leaseMs = resolveIdempotencyLeaseMs(),
}) {
  requireClient(prismaClient);
  const allowedTypes = new Set(['GRANT', 'REFILL', 'REFUND', 'ADMIN_ADJUSTMENT']);
  if (!allowedTypes.has(type)) return { ok: false, code: 'INVALID_TYPE' };
  const identity = buildIdentity({
    userId,
    amount,
    feature: `credits:${type.toLowerCase()}`,
    idempotencyKey,
    requestId,
    requestHash,
  });
  if (!identity) return { ok: false, code: 'INVALID_AMOUNT' };
  return prismaClient.$transaction(async (tx) => {
    await lockOperation(tx, identity.idempotencyKeyHash);
    const existing = await selectByKey(tx, identity.idempotencyKeyHash);
    if (existing) {
      return claimExistingReservation(tx, existing, identity, { now, leaseMs });
    }
    await ensureCreditRowTx(tx, identity.userId, now);

    const grantedAmount = type === 'REFUND' ? 0n : identity.requestedAmount;
    const refundedAmount = type === 'REFUND' ? identity.requestedAmount : 0n;
    const rows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:credit-balance-increment */
      UPDATE "credits"
      SET
        "balance" = "balance" + ${identity.requestedAmount.toString()}::BIGINT,
        "lifetimeGranted" = "lifetimeGranted" + ${grantedAmount.toString()}::BIGINT,
        "lifetimeSpent" = GREATEST(
          0,
          "lifetimeSpent" - ${refundedAmount.toString()}::BIGINT
        ),
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "userId" = ${identity.userId}
      RETURNING "balance", "orgId"
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      const error = new Error('credit balance row unavailable');
      error.code = 'CREDIT_ROW_UNAVAILABLE';
      throw error;
    }
    const txn = await insertTransaction(tx, {
      id: generatedTransactionId('credit'),
      userId: identity.userId,
      orgId: rows[0].orgId || null,
      type,
      amount: identity.requestedAmount,
      balanceAfter: toBigInt(rows[0].balance),
      reason: reason || `${type.toLowerCase()} credits`,
      metadata: initialMetadata({
        metadata,
        identity,
        path: type === 'REFUND' ? 'refund' : 'grant',
        now,
        leaseMs,
      }),
      idempotencyKey: identity.idempotencyKeyHash,
      createdAt: now,
    });
    return {
      ok: true,
      replay: false,
      winner: true,
      ownsLease: true,
      path: txn.metadata.path,
      txn,
      identity,
    };
  });
}

async function getLedgerTransaction({
  prismaClient,
  id,
  userId,
}) {
  requireClient(prismaClient);
  if (!id || !userId) return null;
  return prismaClient.$transaction(
    async (tx) => selectByIdForUpdate(tx, String(id), String(userId)),
  );
}

async function listLedgerTransactions({
  prismaClient,
  userId,
  type,
  limit = 25,
  cursor,
}) {
  requireClient(prismaClient);
  const take = Math.min(101, Math.max(1, Number(limit) || 25));
  return prismaClient.$transaction(async (tx) => {
    const rows = await tx.$queryRaw(Prisma.sql`
      /* credit-ledger:list-transactions */
      SELECT
        "id", "userId", "orgId", "type", "amount", "balanceAfter",
        "reason", "metadata", "idempotencyKey", "createdAt"
      FROM "credit_transactions"
      WHERE "userId" = ${String(userId)}
        AND (${type || null}::TEXT IS NULL OR "type"::TEXT = ${type || null}::TEXT)
        AND (
          ${cursor || null}::TEXT IS NULL
          OR ("createdAt", "id") < (
            SELECT "createdAt", "id"
            FROM "credit_transactions"
            WHERE "id" = ${cursor || null}
              AND "userId" = ${String(userId)}
          )
        )
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${take}
    `);
    return Array.isArray(rows) ? rows.map(normalizeLedgerRow) : [];
  });
}

async function completeLedgerTransition({
  prismaClient,
  transaction,
  response,
  responseUnavailable,
  now = new Date(),
}) {
  requireClient(prismaClient);
  if (!transaction?.id || !transaction?.userId) {
    const error = new Error('credit ledger transaction identity unavailable');
    error.code = 'IDEMPOTENCY_CACHE_UNAVAILABLE';
    throw error;
  }
  return prismaClient.$transaction(async (tx) => {
    const current = await selectByIdForUpdate(tx, transaction.id, transaction.userId);
    if (!current || current.idempotencyKey !== transaction.idempotencyKey) {
      return {
        ok: false,
        code: 'IDEMPOTENCY_CONFLICT',
        existingTransactionId: current?.id || null,
      };
    }
    if (!leaseMatches(current, transaction)) return leaseLostResult(current);
    const state = stateOf(current);
    if (state === 'completed') {
      const cachedResponse = cachedResponseOf(current);
      if (cachedResponse) {
        return {
          ok: true,
          replay: true,
          response: cachedResponse,
          txn: current,
        };
      }
      if (current.metadata.idempotency?.responseUnavailable) {
        return {
          ok: true,
          replay: true,
          responseUnavailable: true,
          txn: current,
        };
      }
      return { ok: false, code: 'IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE' };
    }
    if (TERMINAL_STATES.has(state)) {
      return {
        ok: false,
        code: state === 'failed' ? 'IDEMPOTENCY_FAILED' : 'IDEMPOTENCY_REFUNDED',
        retryable: true,
      };
    }
    if (state === 'refund_pending') {
      return { ok: false, code: 'IDEMPOTENCY_REFUND_PENDING', retryable: true };
    }
    if (state !== 'in_progress') return leaseLostResult(current);
    const completedAt = validDate(now).toISOString();
    const metadata = {
      ...current.metadata,
      idempotency: {
        ...parseMetadata(current.metadata.idempotency),
        state: 'completed',
        response: response || null,
        ...(responseUnavailable ? { responseUnavailable } : {}),
        completedAt,
      },
    };
    const updated = await updateOwnedMetadata(tx, current, metadata, {
      expectedState: 'in_progress',
      leaseToken: leaseTokenOf(transaction),
    });
    if (!updated) return leaseLostResult(current);
    return {
      ok: true,
      ...(response ? { response } : { responseUnavailable: true }),
      txn: updated,
    };
  });
}

async function completeLedgerTransaction({
  prismaClient,
  transaction,
  statusCode = 200,
  body,
  now = new Date(),
}) {
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 599) {
    throw new TypeError('completeLedgerTransaction requires a valid statusCode');
  }
  const response = { statusCode, body: jsonSafeResponse(body) };
  return completeLedgerTransition({
    prismaClient,
    transaction,
    response,
    now,
  });
}

async function completeLedgerTransactionWithoutResponse({
  prismaClient,
  transaction,
  code = 'IDEMPOTENCY_RESPONSE_UNAVAILABLE',
  now = new Date(),
}) {
  const completedAt = validDate(now).toISOString();
  return completeLedgerTransition({
    prismaClient,
    transaction,
    responseUnavailable: {
      code: String(code || 'IDEMPOTENCY_RESPONSE_UNAVAILABLE').slice(0, 100),
      recordedAt: completedAt,
    },
    now,
  });
}

async function failLedgerTransaction({
  prismaClient,
  transaction,
  code = 'REQUEST_FAILED',
  statusCode = 500,
  state: targetState = 'failed',
  now = new Date(),
}) {
  requireClient(prismaClient);
  if (!transaction?.id || !transaction?.userId) {
    const error = new Error('credit ledger transaction identity unavailable');
    error.code = 'IDEMPOTENCY_CACHE_UNAVAILABLE';
    throw error;
  }
  if (!['failed', 'refund_pending'].includes(targetState)) {
    throw new TypeError('failLedgerTransaction state must be failed or refund_pending');
  }
  return prismaClient.$transaction(async (tx) => {
    const current = await selectByIdForUpdate(tx, transaction.id, transaction.userId);
    if (!current || current.idempotencyKey !== transaction.idempotencyKey) {
      return {
        ok: false,
        code: 'IDEMPOTENCY_CONFLICT',
        existingTransactionId: current?.id || null,
      };
    }
    if (!leaseMatches(current, transaction)) return leaseLostResult(current);
    const state = stateOf(current);
    if (state === targetState) return { ok: true, replay: true, txn: current };
    if (TERMINAL_STATES.has(state)) {
      return {
        ok: false,
        code: state === 'refunded' ? 'IDEMPOTENCY_REFUNDED' : 'IDEMPOTENCY_CONFLICT',
      };
    }
    if (state === 'refund_pending' && targetState !== 'refund_pending') {
      return { ok: false, code: 'IDEMPOTENCY_REFUND_PENDING', retryable: true };
    }
    if (state !== 'in_progress') return leaseLostResult(current);
    const transitionAt = validDate(now).toISOString();
    const metadata = {
      ...current.metadata,
      idempotency: {
        ...parseMetadata(current.metadata.idempotency),
        state: targetState,
        response: null,
        failure: {
          code: String(code || 'REQUEST_FAILED').slice(0, 100),
          statusCode: Number.isInteger(statusCode) ? statusCode : 500,
        },
        ...(targetState === 'refund_pending'
          ? { refundPendingAt: transitionAt }
          : { failedAt: transitionAt }),
      },
    };
    const updated = await updateOwnedMetadata(tx, current, metadata, {
      expectedState: 'in_progress',
      leaseToken: leaseTokenOf(transaction),
    });
    if (!updated) return leaseLostResult(current);
    return { ok: true, txn: updated };
  });
}

function deterministicRefundKey(originalTransaction) {
  if (!originalTransaction?.id || !originalTransaction?.userId) return null;
  return hashIdempotencyKey(
    originalTransaction.userId,
    `refund:${originalTransaction.id}`,
  );
}

function legacyRefundSource(row, supplied) {
  if (
    !row
    || !supplied
    || row.type !== 'SPEND'
    || row.amount >= 0n
    || leaseTokenOf(row)
    || leaseTokenOf(supplied)
  ) {
    return null;
  }
  const rowMetadata = parseMetadata(row.metadata);
  const hasIdempotency = Object.prototype.hasOwnProperty.call(
    rowMetadata,
    'idempotency',
  );
  if (!hasIdempotency) {
    return 'pre_idempotency';
  }
  if (
    rowMetadata.path === 'paid'
    && stateOf(row) === 'completed'
  ) {
    return 'pre_fencing';
  }
  return null;
}

function isLegacyRefundReplay(row, supplied) {
  const idempotency = parseMetadata(row?.metadata?.idempotency);
  return Boolean(
    row
    && supplied
    && row.type === 'SPEND'
    && row.amount < 0n
    && stateOf(row) === 'refunded'
    && !leaseTokenOf(row)
    && !leaseTokenOf(supplied)
    && idempotency.legacyRefundCasToken
    && ['pre_fencing', 'pre_idempotency'].includes(idempotency.legacyRefundSource)
    && (
      idempotency.legacyRefundSource === 'pre_idempotency'
      || row.metadata?.path === 'paid'
    ),
  );
}

async function refundLedgerTransaction({
  prismaClient,
  originalTransaction,
  reason,
  metadata,
  now = new Date(),
}) {
  requireClient(prismaClient);
  if (!originalTransaction?.id || !originalTransaction?.userId) {
    return { ok: false, code: 'NO_TXN' };
  }
  return prismaClient.$transaction(async (tx) => {
    const refundKeyHash = deterministicRefundKey(originalTransaction);
    await lockOperation(tx, refundKeyHash);
    const original = await selectByIdForUpdate(
      tx,
      originalTransaction.id,
      originalTransaction.userId,
    );
    if (!original) return { ok: false, code: 'NO_TXN' };
    if (original.idempotencyKey !== originalTransaction.idempotencyKey) {
      return {
        ok: false,
        code: 'IDEMPOTENCY_CONFLICT',
        existingTransactionId: original.id,
      };
    }
    if (
      originalTransaction.type !== original.type
      || toBigInt(originalTransaction.amount, null) !== original.amount
    ) {
      return {
        ok: false,
        code: 'IDEMPOTENCY_CONFLICT',
        existingTransactionId: original.id,
      };
    }
    if (original.type !== 'SPEND' || original.amount >= 0n) {
      return { ok: false, code: 'NOT_REFUNDABLE' };
    }
    const amount = -original.amount;
    const historicalRefund = await selectRefundByOriginalTransaction(
      tx,
      original.userId,
      original.id,
    );
    if (historicalRefund) {
      return {
        ok: true,
        replay: true,
        winner: false,
        txn: historicalRefund,
      };
    }
    const originalState = stateOf(original);
    const legacySource = legacyRefundSource(original, originalTransaction);
    const legacyCompleted = Boolean(legacySource);
    const legacyReplay = isLegacyRefundReplay(original, originalTransaction);
    if (
      !leaseMatches(original, originalTransaction)
      && !legacyCompleted
      && !legacyReplay
    ) {
      return leaseLostResult(original);
    }
    const existingRefund = await selectByKey(tx, refundKeyHash);
    if (existingRefund) {
      const refundMetadata = parseMetadata(existingRefund.metadata);
      if (
        existingRefund.userId !== original.userId
        || existingRefund.type !== 'REFUND'
        || existingRefund.amount !== amount
        || refundMetadata.refundedTxnId !== original.id
      ) {
        return {
          ok: false,
          code: 'IDEMPOTENCY_CONFLICT',
          existingTransactionId: existingRefund.id,
        };
      }
      return {
        ok: true,
        replay: true,
        winner: false,
        txn: existingRefund,
      };
    }
    if (originalState === 'refunded') {
      return {
        ok: false,
        code: 'IDEMPOTENCY_REFUNDED_WITHOUT_LEDGER',
        retryable: false,
      };
    }
    if (
      original.type !== 'SPEND'
      || amount <= 0n
      || (!legacyCompleted && original.metadata.path !== 'paid')
    ) {
      return { ok: false, code: 'NOT_REFUNDABLE' };
    }
    if (
      !legacyCompleted
      && !['in_progress', 'completed', 'failed', 'refund_pending'].includes(originalState)
    ) {
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT', retryable: false };
    }

    const operationNow = validDate(now);
    const leaseToken = leaseTokenOf(originalTransaction);
    const refundId = generatedTransactionId('credit_refund');
    const legacyRefundCasToken = legacyCompleted ? randomUUID() : null;
    const originalMetadata = {
      ...original.metadata,
      idempotency: {
        ...parseMetadata(original.metadata.idempotency),
        state: 'refunded',
        response: null,
        refundTransactionId: refundId,
        refundedAt: operationNow.toISOString(),
        ...(legacyRefundCasToken
          ? {
            legacyRefundCasToken,
            legacyRefundSource: legacySource,
          }
          : {}),
      },
    };
    const transitioned = legacyCompleted
      ? await updateLegacyRefundMetadata(tx, original, originalMetadata, legacySource)
      : await updateOwnedMetadata(tx, original, originalMetadata, {
        expectedState: originalState,
        leaseToken,
      });
    if (!transitioned) return leaseLostResult(original);
    const balanceRows = legacyCompleted
      ? await tx.$queryRaw(Prisma.sql`
        /* credit-ledger:legacy-refund-balance */
        UPDATE "credits"
        SET
          "balance" = "balance" + ${amount.toString()}::BIGINT,
          "lifetimeSpent" = GREATEST(
            0,
            "lifetimeSpent" - ${amount.toString()}::BIGINT
          ),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "userId" = ${original.userId}
          AND EXISTS (
            SELECT 1
            FROM "credit_transactions" AS legacy_refund
            WHERE legacy_refund."id" = ${original.id}
              AND legacy_refund."userId" = ${original.userId}
              AND legacy_refund."metadata"->'idempotency'->>'state' = 'refunded'
              AND legacy_refund."metadata"->'idempotency'->>'leaseToken' IS NULL
              AND legacy_refund."metadata"->'idempotency'->>'legacyRefundCasToken'
                = ${legacyRefundCasToken}
              AND legacy_refund."metadata"->'idempotency'->>'refundTransactionId'
                = ${refundId}
          )
        RETURNING "balance", "orgId"
      `)
      : await tx.$queryRaw(Prisma.sql`
        /* credit-ledger:refund-balance */
        UPDATE "credits"
        SET
          "balance" = "balance" + ${amount.toString()}::BIGINT,
          "lifetimeSpent" = GREATEST(
            0,
            "lifetimeSpent" - ${amount.toString()}::BIGINT
          ),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "userId" = ${original.userId}
          AND EXISTS (
            SELECT 1
            FROM "credit_transactions" AS owned_refund
            WHERE owned_refund."id" = ${original.id}
              AND owned_refund."userId" = ${original.userId}
              AND owned_refund."metadata"->'idempotency'->>'state' = 'refunded'
              AND owned_refund."metadata"->'idempotency'->>'leaseToken' = ${leaseToken}
              AND owned_refund."metadata"->'idempotency'->>'refundTransactionId' = ${refundId}
          )
        RETURNING "balance", "orgId"
      `);
    if (!Array.isArray(balanceRows) || balanceRows.length === 0) {
      const error = new Error('credit row unavailable for refund');
      error.code = 'REFUND_BALANCE_UNAVAILABLE';
      throw error;
    }
    const refundTxn = await insertTransaction(tx, {
      id: refundId,
      userId: original.userId,
      orgId: balanceRows[0].orgId || original.orgId || null,
      type: 'REFUND',
      amount,
      balanceAfter: toBigInt(balanceRows[0].balance),
      reason: reason || `refund(${original.id})`,
      metadata: {
        ...parseMetadata(metadata),
        feature: original.metadata.feature,
        requestHash: original.metadata.requestHash,
        requestedAmount: amount.toString(),
        path: 'refund',
        refundedTxnId: original.id,
        idempotency: {
          state: 'completed',
          response: {
            statusCode: 200,
            body: { refundedTransactionId: original.id },
          },
          completedAt: operationNow.toISOString(),
        },
      },
      idempotencyKey: refundKeyHash,
      createdAt: operationNow,
    });
    return {
      ok: true,
      replay: false,
      winner: true,
      txn: refundTxn,
    };
  });
}

module.exports = {
  DEFAULT_IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_PREFIX,
  MAX_CACHED_RESPONSE_BYTES,
  MAX_IDEMPOTENCY_LEASE_MS,
  MIN_IDEMPOTENCY_LEASE_MS,
  attachLedgerResource,
  cachedResponseOf,
  claimExistingReservation,
  completeLedgerTransaction,
  completeLedgerTransactionWithoutResponse,
  deterministicRefundKey,
  existingReservationResult,
  failLedgerTransaction,
  ensureCreditBalanceRow,
  getCreditBalanceRow,
  getLedgerTransaction,
  hashIdempotencyKey,
  heartbeatLedgerLease,
  listLedgerTransactions,
  identityMatches,
  normalizeLedgerRow,
  refundLedgerTransaction,
  resolveIdempotencyLeaseMs,
  reserveCreditGrant,
  reserveFallbackCharge,
  reservePaidCharge,
  startLedgerLeaseHeartbeat,
  stateOf,
  supportsRawLedgerClient,
};
