'use strict';

const { getFreeDailyWindow } = require('./plan-quota');
const {
  completeLedgerTransaction,
  failLedgerTransaction,
  hashIdempotencyKey,
  reserveFallbackCharge,
} = require('./credit-ledger');

const DEFAULT_FALLBACK_DAILY_LIMIT = 10;
const MAX_FALLBACK_DAILY_LIMIT = 1000;

function resolveFallbackDailyLimit(env = process.env) {
  const parsed = Number.parseInt(env.FREE_IA_FALLBACK_DAILY_LIMIT || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FALLBACK_DAILY_LIMIT;
  return Math.min(MAX_FALLBACK_DAILY_LIMIT, parsed);
}

function isDurableClient(prismaClient) {
  return Boolean(prismaClient && typeof prismaClient.$transaction === 'function');
}

function requestIdentity({
  userId,
  feature,
  idempotencyKey,
  requestId,
  requestHash,
}) {
  const requestKey = String(idempotencyKey || requestId || '').trim();
  if (!userId || !feature || !requestKey || !requestHash) return null;
  return {
    userId,
    feature,
    requestHash,
    idempotencyKeyHash: hashIdempotencyKey(userId, requestKey),
  };
}

function reservationFromResult(result) {
  if (!result?.txn) return null;
  return {
    transaction: result.txn,
    transactionId: result.txn.id,
    userId: result.txn.userId,
    feature: result.txn.metadata?.feature,
    requestHash: result.txn.metadata?.requestHash,
    requestedAmount: result.txn.metadata?.requestedAmount,
    idempotencyKeyHash: result.txn.idempotencyKey,
  };
}

function unavailable() {
  return {
    ok: false,
    code: 'FALLBACK_QUOTA_UNAVAILABLE',
    retryable: true,
  };
}

async function reserveFallbackQuota({
  prismaClient,
  userId,
  feature,
  idempotencyKey,
  requestId,
  requestHash,
  amount = 1,
  reason,
  metadata,
  env = process.env,
  now = new Date(),
} = {}) {
  const identity = requestIdentity({
    userId,
    feature,
    idempotencyKey,
    requestId,
    requestHash,
  });
  if (!identity || !isDurableClient(prismaClient)) return unavailable();

  const limit = resolveFallbackDailyLimit(env);
  const { start, end } = getFreeDailyWindow(now, env);
  try {
    const result = await reserveFallbackCharge({
      prismaClient,
      userId,
      amount,
      feature,
      reason,
      metadata,
      idempotencyKey,
      requestId,
      requestHash,
      dailyLimit: limit,
      windowStart: start,
      windowEnd: end,
      now,
    });
    if (!result?.ok) return result || unavailable();
    return {
      ...result,
      reservation: reservationFromResult(result),
    };
  } catch {
    return unavailable();
  }
}

async function completeFallbackReservation({
  prismaClient,
  reservation,
  statusCode = 200,
  body,
} = {}) {
  const transaction = reservation?.transaction;
  if (!isDurableClient(prismaClient) || !transaction) {
    const error = new Error('fallback reservation storage unavailable');
    error.code = 'FALLBACK_CACHE_UNAVAILABLE';
    throw error;
  }
  return completeLedgerTransaction({
    prismaClient,
    transaction,
    statusCode,
    body,
  });
}

async function failFallbackReservation({
  prismaClient,
  reservation,
  code,
  statusCode,
} = {}) {
  const transaction = reservation?.transaction;
  if (!isDurableClient(prismaClient) || !transaction) {
    const error = new Error('fallback reservation storage unavailable');
    error.code = 'FALLBACK_CACHE_UNAVAILABLE';
    throw error;
  }
  return failLedgerTransaction({
    prismaClient,
    transaction,
    code,
    statusCode,
  });
}

module.exports = {
  DEFAULT_FALLBACK_DAILY_LIMIT,
  MAX_FALLBACK_DAILY_LIMIT,
  completeFallbackReservation,
  failFallbackReservation,
  requestIdentity,
  reservationFromResult,
  reserveFallbackQuota,
  resolveFallbackDailyLimit,
};

