'use strict';

const { randomUUID } = require('node:crypto');

/**
 * F2 PR8 — chargeCredits middleware factory.
 *
 * Pre-charges the authenticated user's credit balance atomically before
 * the wrapped handler runs. Stashes the resulting transaction on the
 * request as `req._chargedCredits` so handlers can refund on a failed
 * downstream call (LLM 5xx, moderation rejection, etc.) by calling
 * `refundLastCharge(req, reason?)`.
 *
 * Usage:
 *   router.post('/paraphrase',
 *     authenticateToken,
 *     chargeCredits({
 *       feature: 'paraphrase',
 *       cost: (req) => Math.max(1, Math.ceil((req.body.text || '').length / 1000)),
 *     }),
 *     handler);
 *
 * On insufficient credits: opted-in text routes may reserve a zero-amount
 * Free-IA/Cerebras SPEND row; opted-out or unconfigured routes retain 402.
 * Paid and fallback paths share one user-scoped hashed idempotency namespace.
 *
 * Idempotency: honours `Idempotency-Key` header (or body field) — a
 * replay returns the existing transaction without double-charging.
 */

const prisma = require('../config/database');
const {
  buildFreeIaModelDescriptor,
  getCerebrasConfig,
} = require('../services/ai/cerebras-client');
const {
  attachLedgerResource,
  cachedResponseOf,
  completeLedgerTransaction,
  completeLedgerTransactionWithoutResponse,
  deterministicRefundKey,
  failLedgerTransaction,
  heartbeatLedgerLease,
  refundLedgerTransaction,
  reservePaidCharge,
  startLedgerLeaseHeartbeat,
} = require('../services/credit-ledger');
const {
  reserveFallbackQuota,
} = require('../services/free-ia-fallback-quota');
const { sha256Hex } = require('../utils/canonical-json');

function pickIdempotencyKey(req) {
  return (
    req.get?.('Idempotency-Key') ||
    req.get?.('idempotency-key') ||
    req.body?.idempotencyKey ||
    null
  );
}

function deriveRequestHash(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body)
    ? body
    : {};
  const payload = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'idempotencyKey') payload[key] = value;
  }
  return sha256Hex(payload);
}

function normalizeRequestPath(req) {
  const baseUrl = String(req?.baseUrl || '').trim();
  const routePath = typeof req?.route?.path === 'string' ? req.route.path : '';
  const fallbackPath = String(
    req?.path
    || req?.originalUrl
    || req?.url
    || '/',
  ).split('?', 1)[0];
  const combined = routePath ? `${baseUrl}/${routePath}` : fallbackPath;
  const normalized = `/${combined}`
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  return normalized || '/';
}

function omitIdempotencyKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() !== 'idempotencykey') result[key] = entry;
  }
  return result;
}

function deriveRequestFingerprint(req) {
  return sha256Hex({
    method: String(req?.method || 'POST').trim().toUpperCase(),
    route: normalizeRequestPath(req),
    params: omitIdempotencyKey(req?.params),
    query: omitIdempotencyKey(req?.query),
    body: omitIdempotencyKey(req?.body),
  });
}

function resolveCost(spec, req) {
  let value;
  if (typeof spec === 'function') value = spec(req);
  else if (typeof spec === 'number') value = spec;
  else if (typeof spec === 'string' && /^\d+$/.test(spec)) value = Number(spec);
  else return 0;
  // Credit costs MUST be non-negative integers — the ledger stores BigInt and
  // `BigInt(1.5)` throws RangeError, which would 500 EVERY charged request if a
  // price env var (e.g. CREDITS_IMAGE_BASE, CREDITS_PARAPHRASE_PER_1K_CHARS) is
  // set to a fractional value. Round UP so we never under-charge.
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n);
}

function resolveFreeIaFallback() {
  const config = getCerebrasConfig();
  if (!config.enabled) return null;
  return {
    config: {
      enabled: true,
      provider: config.provider,
      model: config.model,
      displayName: config.displayName,
      reason: config.reason,
    },
    descriptor: buildFreeIaModelDescriptor(),
  };
}

function readCachedResponse(transaction) {
  return cachedResponseOf(transaction);
}

/**
 * Atomically spend `amount` credits for `userId` against the new
 * credits ledger. Returns either:
 *   { ok: true, replay?: true, txn: <CreditTransaction> }
 * or:
 *   { ok: false, code: 'INSUFFICIENT' | 'INVALID_AMOUNT' }
 */
async function spendCredits({
  userId,
  amount,
  feature,
  reason,
  metadata,
  idempotencyKey,
  requestHash,
  prismaClient = prisma,
}) {
  const numeric = typeof amount === 'bigint' ? Number(amount) : Number(amount);
  if (!userId || !Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT' };
  }
  if (idempotencyKey && (typeof requestHash !== 'string' || !requestHash)) {
    return { ok: false, code: 'INVALID_REQUEST_HASH' };
  }
  return reservePaidCharge({
    prismaClient,
    userId,
    amount,
    feature,
    reason,
    metadata,
    idempotencyKey,
    requestHash: requestHash || deriveRequestHash({}),
  });
}

/**
 * Reverse a previously-recorded SPEND by issuing a REFUND of the same
 * absolute amount and crediting the balance back. Used in error paths
 * (`refundLastCharge(req, reason)`) so a 5xx from the downstream LLM
 * doesn't drain user credits.
 */
async function refundCharge({
  originalTxn,
  reason,
  metadata,
  prismaClient = prisma,
}) {
  return refundLedgerTransaction({
    prismaClient,
    originalTransaction: originalTxn,
    reason,
    metadata,
  });
}

async function cacheIdempotentResponse(req, {
  statusCode = 200,
  body,
} = {}, prismaClient = prisma) {
  const charge = req?._chargedCredits;
  if (!charge?.txn) {
    return { ok: true, skipped: true };
  }
  return completeLedgerTransaction({
    prismaClient,
    transaction: charge.txn,
    statusCode,
    body,
  });
}

async function attachIdempotentResource(req, {
  resourceType,
  resourceId,
  resourceSpec,
} = {}, prismaClient = prisma) {
  const charge = req?._chargedCredits;
  if (!charge?.txn) return { ok: false, code: 'NO_TXN' };
  const result = await attachLedgerResource({
    prismaClient,
    transaction: charge.txn,
    resourceType,
    resourceId,
    resourceSpec,
  });
  if (result?.ok && result.txn) {
    charge.txn = result.txn;
    if (charge.reservation?.transaction) {
      charge.reservation.transaction = result.txn;
    }
  }
  return result;
}

async function completeIdempotentResponseUnavailable(req, {
  code,
} = {}, prismaClient = prisma) {
  const charge = req?._chargedCredits;
  if (!charge?.txn) return { ok: true, skipped: true };
  return completeLedgerTransactionWithoutResponse({
    prismaClient,
    transaction: charge.txn,
    code,
  });
}

function startIdempotencyLeaseHeartbeat(req, {
  prismaClient = prisma,
  abortController,
  leaseMs,
  intervalMs,
  onLeaseLost,
  onError,
} = {}) {
  const charge = req?._chargedCredits;
  if (!charge?.txn || charge.ownsLease !== true || charge.replay) {
    return {
      timer: null,
      leaseLost: false,
      async stop() {},
    };
  }
  return startLedgerLeaseHeartbeat({
    prismaClient,
    transaction: charge.txn,
    leaseMs,
    intervalMs,
    onLeaseLost(result) {
      const error = new Error('idempotency lease ownership lost');
      error.code = 'LEASE_LOST';
      error.transactionId = result?.existingTransactionId || charge.txn.id;
      if (abortController && !abortController.signal?.aborted) {
        abortController.abort(error);
      }
      onLeaseLost?.(result, error);
    },
    onError(error) {
      req.log?.warn?.(
        { err: error, chargeTransactionId: charge.txn.id },
        'credit idempotency lease heartbeat failed',
      );
      onError?.(error);
    },
  });
}

async function verifyIdempotentLeaseOwnership(req, {
  prismaClient = prisma,
  leaseMs,
} = {}) {
  const charge = req?._chargedCredits;
  if (!charge?.txn || charge.ownsLease !== true || charge.replay) {
    return { ok: false, code: 'LEASE_LOST', retryable: true };
  }
  const result = await heartbeatLedgerLease({
    prismaClient,
    transaction: charge.txn,
    leaseMs,
  });
  if (result?.ok && result.txn) {
    charge.txn = result.txn;
    if (charge.reservation?.transaction) {
      charge.reservation.transaction = result.txn;
    }
  }
  return result;
}

async function failIdempotentOperation(req, {
  code,
  statusCode,
  state,
} = {}, prismaClient = prisma) {
  const charge = req?._chargedCredits;
  if (!charge?.txn) return { ok: true, skipped: true };
  return failLedgerTransaction({
    prismaClient,
    transaction: charge.txn,
    code,
    statusCode,
    state,
  });
}

function setDurableFallbackHeaders(res, transaction) {
  const metadata = transaction?.metadata;
  if (metadata?.path !== 'free_ia' || typeof res?.setHeader !== 'function' || res.headersSent) {
    return;
  }
  res.setHeader('x-sira-fallback', 'free-ia');
  res.setHeader('x-sira-fallback-feature', String(metadata.feature || 'unknown'));
  res.setHeader('x-sira-fallback-cost', String(metadata.requestedAmount || '0'));
}

function sendCachedReplay(res, cachedResponse, transaction) {
  if (typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader('x-sira-idempotent-replay', 'true');
  }
  setDurableFallbackHeaders(res, transaction);
  return res.status(cachedResponse.statusCode).json(cachedResponse.body);
}

async function sendReservationFailure(res, result, prismaClient = prisma) {
  if (result?.code === 'IDEMPOTENCY_CONFLICT') {
    return res.status(409).json({
      error: 'idempotency conflict',
      code: result.code,
      retryable: false,
    });
  }
  if (
    result?.code === 'IDEMPOTENCY_IN_PROGRESS'
    || result?.code === 'IDEMPOTENCY_FAILED'
    || result?.code === 'IDEMPOTENCY_REFUNDED'
    || result?.code === 'LEASE_LOST'
  ) {
    return res.status(409).json({
      error: 'idempotent request cannot be replayed in its current state',
      code: result.code,
      retryable: true,
    });
  }
  if (result?.code === 'IDEMPOTENCY_REFUND_PENDING') {
    try {
      const reconciled = await refundLedgerTransaction({
        prismaClient,
        originalTransaction: result.txn,
        reason: 'reconcile_refund_pending',
      });
      if (reconciled?.ok) {
        return res.status(409).json({
          error: 'idempotent request charge was refunded during reconciliation',
          code: 'IDEMPOTENCY_REFUNDED',
          retryable: true,
        });
      }
    } catch {
      // Preserve the durable refund_pending state; a later replay can retry.
    }
    return res.status(503).json({
      error: 'credit refund reconciliation pending',
      code: 'IDEMPOTENCY_REFUND_PENDING',
      retryable: true,
      transactionId: result?.txn?.id || result?.existingTransactionId || null,
    });
  }
  if (result?.code === 'IDEMPOTENCY_COMPLETED_WITHOUT_RESPONSE') {
    return res.status(409).json({
      error: 'idempotent request completed without a replayable response',
      code: result.code,
      retryable: false,
      retryWithNewIdempotencyKey: true,
    });
  }
  if (result?.code === 'FALLBACK_QUOTA_EXCEEDED') {
    return res.status(429).json({
      error: 'Free IA fallback quota exhausted',
      code: result.code,
      limit: result.limit,
      used: result.used,
    });
  }
  if (result?.code === 'FALLBACK_QUOTA_UNAVAILABLE') {
    return res.status(503).json({
      error: 'Free IA fallback quota unavailable',
      code: result.code,
      retryable: true,
    });
  }
  return null;
}

function fallbackReservationFor(result) {
  if (result?.reservation?.transaction) return result.reservation;
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

function attachFallbackCharge(req, {
  result,
  fallback,
  feature,
  amount,
  clientIdempotencyKey,
  requestHash,
}) {
  req._creditsExhausted = true;
  req._fallbackToFreeIA = fallback;
  req._chargedCredits = {
    feature,
    amount,
    txn: result.txn,
    replay: false,
    recovered: result.recovered === true,
    durableWinner: result.winner === true,
    ownsLease: result.ownsLease === true,
    fallback: 'free_ia',
    idempotencyKeyHash: result.txn?.idempotencyKey || null,
    clientProvidedIdempotencyKey: Boolean(clientIdempotencyKey),
    requestHash,
    reservation: fallbackReservationFor(result),
  };
}

/**
 * Middleware factory.
 */
function chargeCredits(spec = {}) {
  const {
    feature,
    cost,
    reason,
    metadata,
    allowFreeIaFallback = false,
  } = spec;
  if (!feature || typeof feature !== 'string') {
    throw new Error('chargeCredits: { feature } is required');
  }
  return async function chargeCreditsMiddleware(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'auth required' });
      }
      const amount = resolveCost(cost, req);
      if (!amount || amount <= 0) {
        // Zero-cost features (e.g. internal admin previews) bypass the
        // ledger so the route still runs.
        return next();
      }
      const clientIdempotencyKey = pickIdempotencyKey(req);
      const operationKey = clientIdempotencyKey || req.id || `request:${randomUUID()}`;
      const requestHash = deriveRequestFingerprint(req);
      const chargeMetadata = typeof metadata === 'function' ? metadata(req) : metadata;
      const result = await spendCredits({
        userId: req.user.id,
        amount,
        feature,
        reason,
        metadata: chargeMetadata,
        idempotencyKey: operationKey,
        requestHash,
      });
      if (!result.ok) {
        const reservationFailure = await sendReservationFailure(res, result);
        if (reservationFailure) return reservationFailure;
        if (result.code === 'INSUFFICIENT') {
          const fallback = allowFreeIaFallback ? resolveFreeIaFallback() : null;
          if (!fallback) {
            return res.status(402).json({
              error: 'insufficient credits',
              feature,
              costRequested: String(amount),
            });
          }
          const fallbackResult = await reserveFallbackQuota({
            prismaClient: prisma,
            userId: req.user.id,
            amount,
            feature,
            reason: reason || `fallback(${feature})`,
            metadata: {
              ...(chargeMetadata && typeof chargeMetadata === 'object' ? chargeMetadata : {}),
              provider: fallback.config.provider,
              model: fallback.config.model,
            },
            idempotencyKey: operationKey,
            requestId: req.id,
            requestHash,
          });
          if (!fallbackResult?.ok) {
            return await sendReservationFailure(res, fallbackResult)
              || res.status(503).json({
                error: 'Free IA fallback quota unavailable',
                code: 'FALLBACK_QUOTA_UNAVAILABLE',
                retryable: true,
              });
          }
          if (fallbackResult.replay) {
            if (fallbackResult.cachedResponse) {
              return sendCachedReplay(
                res,
                fallbackResult.cachedResponse,
                fallbackResult.txn,
              );
            }
            return sendReservationFailure(res, {
              code: 'IDEMPOTENCY_IN_PROGRESS',
            });
          }
          attachFallbackCharge(req, {
            result: fallbackResult,
            fallback,
            feature,
            amount,
            clientIdempotencyKey,
            requestHash,
          });
          return next();
        }
        return res.status(400).json({ error: 'invalid charge amount' });
      }
      if (result.replay) {
        return sendCachedReplay(res, result.cachedResponse, result.txn);
      }
      if (result.path === 'free_ia') {
        const fallback = allowFreeIaFallback ? resolveFreeIaFallback() : null;
        if (!fallback) {
          await failLedgerTransaction({
            prismaClient: prisma,
            transaction: result.txn,
            code: 'FALLBACK_PROVIDER_UNAVAILABLE',
            statusCode: 503,
          });
          return res.status(503).json({
            error: 'Free IA fallback provider unavailable',
            code: 'FALLBACK_PROVIDER_UNAVAILABLE',
            retryable: true,
          });
        }
        attachFallbackCharge(req, {
          result,
          fallback,
          feature,
          amount,
          clientIdempotencyKey,
          requestHash,
        });
        return next();
      }
      req._chargedCredits = {
        feature,
        amount,
        txn: result.txn,
        replay: false,
        recovered: result.recovered === true,
        durableWinner: result.winner === true,
        ownsLease: result.ownsLease === true,
        idempotencyKeyHash: result.txn?.idempotencyKey || null,
        clientProvidedIdempotencyKey: Boolean(clientIdempotencyKey),
        requestHash,
      };
      return next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Convenience helper for route handlers — refund the most recent
 * charge attached to the request. No-op if no charge is recorded.
 */
async function refundLastCharge(req, reason, {
  strict = false,
  prismaClient = prisma,
} = {}) {
  const charge = req._chargedCredits;
  // Never refund a replay or a zero-amount fallback reservation.
  if (!charge || charge.replay || !charge.txn || charge.fallback) return null;
  try {
    const result = await refundCharge({
      originalTxn: charge.txn,
      reason: reason || `auto-refund(${charge.feature})`,
      prismaClient,
    });
    req._refundedCredits = result;
    return result;
  } catch (err) {
    if (strict) throw err;
    if (req.log?.warn) req.log.warn({ err }, 'refundLastCharge failed');
    return null;
  }
}

module.exports = chargeCredits;
module.exports.chargeCredits = chargeCredits;
module.exports.spendCredits = spendCredits;
module.exports.refundCharge = refundCharge;
module.exports.refundLastCharge = refundLastCharge;
module.exports.resolveCost = resolveCost;
module.exports.pickIdempotencyKey = pickIdempotencyKey;
module.exports.resolveFreeIaFallback = resolveFreeIaFallback;
module.exports.attachIdempotentResource = attachIdempotentResource;
module.exports.cacheIdempotentResponse = cacheIdempotentResponse;
module.exports.completeIdempotentResponseUnavailable = completeIdempotentResponseUnavailable;
module.exports.failIdempotentOperation = failIdempotentOperation;
module.exports.deriveRequestHash = deriveRequestHash;
module.exports.deriveRequestFingerprint = deriveRequestFingerprint;
module.exports.deterministicRefundKey = deterministicRefundKey;
module.exports.readCachedResponse = readCachedResponse;
module.exports.startIdempotencyLeaseHeartbeat = startIdempotencyLeaseHeartbeat;
module.exports.verifyIdempotentLeaseOwnership = verifyIdempotentLeaseOwnership;
