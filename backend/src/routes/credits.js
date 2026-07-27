'use strict';

/**
 * /api/credits — F2 PR7 — Per-user credit balance + ledger + admin ops.
 *
 *   GET    /api/credits/me                       me, balance + counters
 *   GET    /api/credits/me/transactions          me, paginated ledger
 *   POST   /api/credits/spend                    admin OR internal; idempotent
 *   POST   /api/admin/credits/grant              admin; idempotent
 *   POST   /api/admin/credits/refund             admin; idempotent
 *   GET    /api/admin/credits/users/:userId      admin view
 *
 * Race-safety: SPEND uses a single atomic UPDATE with a balance guard
 * (`UPDATE credits SET balance = balance - $amt WHERE userId=$u AND
 *  balance >= $amt RETURNING balance`) so concurrent debits cannot
 * underflow. GRANT/REFUND increment via `prisma.update` increments —
 * Postgres serialises the row update.
 *
 * Idempotency: every write accepts an `Idempotency-Key` header (or a
 * field in the body) and stores it on `credit_transactions.idempotencyKey`,
 * guarded by the partial unique index from F1 PR3. A duplicate replay
 * returns the existing transaction without double-charging.
 *
 * Until F2 PR9/PR10 wire `requirePermission()`, admin endpoints gate on
 * the legacy `req.user.isSuperAdmin` flag.
 */

const express = require('express');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth');
const { makeBillingRateLimit } = require('../middleware/billing-rate-limit');
const requireAdminRoutePermission = require('../services/admin-route-policy');
const { parsePositiveInt } = require('../services/chat-scope');
const prisma = require('../config/database');
const {
  completeLedgerTransaction,
  ensureCreditBalanceRow,
  getCreditBalanceRow,
  getLedgerTransaction,
  listLedgerTransactions,
  refundLedgerTransaction,
  reserveCreditGrant,
  reservePaidCharge,
} = require('../services/credit-ledger');
const { sha256Hex } = require('../utils/canonical-json');

const meRouter = express.Router();
const adminRouter = express.Router();
adminRouter.use(authenticateToken, requireAdminRoutePermission);

const adminCreditBillingLimit = parsePositiveInt(
  process.env.RATE_LIMIT_BILLING_REFUND_MAX,
  5,
  { min: 1, max: 1000 },
);
const adminCreditBillingIpLimit = parsePositiveInt(
  process.env.RATE_LIMIT_BILLING_REFUND_IP_MAX,
  50,
  { min: adminCreditBillingLimit, max: 100_000 },
);
const adminCreditBillingWindowMs = parsePositiveInt(
  process.env.RATE_LIMIT_BILLING_REFUND_WINDOW_MS,
  60 * 60 * 1000,
  { min: 1000, max: 24 * 60 * 60 * 1000 },
);
const grantBillingRateLimit = makeBillingRateLimit({
  name: 'admin-credit-grant',
  limit: adminCreditBillingLimit,
  ipLimit: adminCreditBillingIpLimit,
  windowMs: adminCreditBillingWindowMs,
});
const refundBillingRateLimit = makeBillingRateLimit({
  name: 'admin-credit-refund',
  limit: adminCreditBillingLimit,
  ipLimit: adminCreditBillingIpLimit,
  windowMs: adminCreditBillingWindowMs,
});

const CreditAmountSchema = z.union([
  z.number().int().positive().max(1_000_000_000),
  z.string().regex(/^\d+$/),
]);

const SpendSchema = z.object({
  userId: z.string().min(1).max(64),
  amount: CreditAmountSchema,
  feature: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128).optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const GrantSchema = z.object({
  userId: z.string().min(1).max(64),
  amount: CreditAmountSchema,
  reason: z.string().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const RefundSchema = z.object({
  userId: z.string().min(1).max(64),
  transactionId: z.string().min(1).max(64).optional(),
  amount: CreditAmountSchema.optional(),
  reason: z.string().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// ── Helpers ────────────────────────────────────────────────────────
function bigToStr(value) {
  if (value === null || value === undefined) return '0';
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function serializeCredits(row) {
  if (!row) return null;
  return {
    userId: row.userId,
    orgId: row.orgId,
    balance: bigToStr(row.balance),
    reservedBalance: bigToStr(row.reservedBalance),
    lifetimeGranted: bigToStr(row.lifetimeGranted),
    lifetimeSpent: bigToStr(row.lifetimeSpent),
    lastRefillAt: row.lastRefillAt,
    nextRefillAt: row.nextRefillAt,
    updatedAt: row.updatedAt,
  };
}

function serializeTransaction(tx) {
  return {
    id: tx.id,
    userId: tx.userId,
    orgId: tx.orgId,
    type: tx.type,
    amount: bigToStr(tx.amount),
    balanceAfter: bigToStr(tx.balanceAfter),
    reason: tx.reason,
    metadata: tx.metadata ?? {},
    idempotencyKey: tx.idempotencyKey,
    createdAt: tx.createdAt,
  };
}

function pickIdempotencyKey(req, bodyKey) {
  return (
    req.get('Idempotency-Key') ||
    req.get('idempotency-key') ||
    bodyKey ||
    null
  );
}

function requireSuperAdmin(req, res) {
  if (!req.user || !req.user.isSuperAdmin) {
    res.status(403).json({ error: 'forbidden', missingPermission: 'credits.adjust' });
    return false;
  }
  return true;
}

function requireCreditSuperAdmin(req, res, next) {
  if (!requireSuperAdmin(req, res)) return undefined;
  return next();
}

function deriveWriteRequestHash(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body)
    ? body
    : {};
  const payload = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'idempotencyKey') payload[key] = value;
  }
  return sha256Hex(payload);
}

async function ensureCreditRow(userId, prismaClient = prisma) {
  return ensureCreditBalanceRow({
    prismaClient,
    userId,
  });
}

async function getCreditRow(userId, prismaClient = prisma) {
  return getCreditBalanceRow({
    prismaClient,
    userId,
  });
}

// Atomic spend. Returns either { ok: true, balanceAfter, txn } or
// { ok: false, code: 'INSUFFICIENT' }.
async function atomicSpend({
  prismaClient = prisma,
  userId,
  amount,
  feature,
  reason,
  metadata,
  idempotencyKey,
  requestId,
  requestHash,
}) {
  return reservePaidCharge({
    prismaClient,
    userId,
    amount,
    feature,
    reason,
    metadata,
    idempotencyKey,
    requestId,
    requestHash,
  });
}

async function atomicGrant({
  prismaClient = prisma,
  userId,
  amount,
  type,
  reason,
  metadata,
  idempotencyKey,
  requestId,
  requestHash,
}) {
  return reserveCreditGrant({
    prismaClient,
    userId,
    amount,
    type,
    reason,
    metadata,
    idempotencyKey,
    requestId,
    requestHash,
  });
}

function sendWriteFailure(res, result) {
  if (result?.code === 'INSUFFICIENT') {
    return res.status(402).json({ error: 'insufficient credits' });
  }
  if (
    String(result?.code || '').startsWith('IDEMPOTENCY_')
    || result?.code === 'LEASE_LOST'
  ) {
    return res.status(409).json({
      error: 'idempotency conflict',
      code: result.code,
      retryable: result.retryable === true,
    });
  }
  return res.status(400).json({
    error: 'invalid credit operation',
    code: result?.code || 'INVALID_CREDIT_OPERATION',
  });
}

async function persistWriteResponse(
  result,
  statusCode,
  body,
  prismaClient = prisma,
) {
  if (!result?.ownsLease || !result?.txn) return;
  const completed = await completeLedgerTransaction({
    prismaClient,
    transaction: result.txn,
    statusCode,
    body,
  });
  if (!completed?.ok) {
    const error = new Error('credit response persistence failed');
    error.code = completed?.code || 'IDEMPOTENCY_CACHE_FAILED';
    throw error;
  }
}

// ── User-facing routes ─────────────────────────────────────────────
meRouter.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const row = await ensureCreditRow(req.user.id);
    res.json({ credits: serializeCredits(row) });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/me/transactions', authenticateToken, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const items = await listLedgerTransactions({
      prismaClient: prisma,
      userId: req.user.id,
      type: req.query.type ? String(req.query.type) : null,
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      limit: limit + 1,
    });
    const hasMore = items.length > limit;
    const sliced = hasMore ? items.slice(0, limit) : items;
    res.json({
      transactions: sliced.map(serializeTransaction),
      nextCursor: hasMore ? sliced[sliced.length - 1].id : null,
    });
  } catch (err) {
    next(err);
  }
});

meRouter.post('/spend', authenticateToken, async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const parse = SpendSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = parse.data;
    const idempotencyKey = pickIdempotencyKey(req, data.idempotencyKey);
    const result = await atomicSpend({
      ...data,
      idempotencyKey,
      requestId: req.id,
      requestHash: deriveWriteRequestHash(req.body),
    });
    if (!result.ok) {
      return sendWriteFailure(res, result);
    }
    if (result.replay && result.cachedResponse) {
      return res
        .status(result.cachedResponse.statusCode)
        .json(result.cachedResponse.body);
    }
    const responseBody = {
      transaction: serializeTransaction(result.txn),
      replay: false,
    };
    await persistWriteResponse(result, 201, responseBody);
    return res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

// ── Admin routes ───────────────────────────────────────────────────
adminRouter.post('/grant', requireCreditSuperAdmin, grantBillingRateLimit, async (req, res, next) => {
  try {
    const parse = GrantSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = parse.data;
    const idempotencyKey = pickIdempotencyKey(req, data.idempotencyKey);
    const result = await atomicGrant({
      ...data,
      type: 'ADMIN_ADJUSTMENT',
      idempotencyKey,
      requestId: req.id,
      requestHash: deriveWriteRequestHash(req.body),
    });
    if (!result.ok) return sendWriteFailure(res, result);
    if (result.replay && result.cachedResponse) {
      return res
        .status(result.cachedResponse.statusCode)
        .json(result.cachedResponse.body);
    }
    const responseBody = {
      transaction: serializeTransaction(result.txn),
      replay: false,
    };
    await persistWriteResponse(result, 201, responseBody);
    return res.status(201).json(responseBody);
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/refund', requireCreditSuperAdmin, refundBillingRateLimit, async (req, res, next) => {
  try {
    const parse = RefundSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = parse.data;
    const idempotencyKey = pickIdempotencyKey(req, data.idempotencyKey);
    let result;
    if (data.transactionId) {
      const original = await getLedgerTransaction({
        prismaClient: prisma,
        id: data.transactionId,
        userId: data.userId,
      });
      if (!original || original.userId !== data.userId) {
        return res.status(404).json({ error: 'transaction not found for user' });
      }
      if (original.type !== 'SPEND') {
        return res.status(400).json({ error: 'can only refund SPEND transactions' });
      }
      result = await refundLedgerTransaction({
        prismaClient: prisma,
        originalTransaction: original,
        reason: data.reason,
        metadata: data.metadata,
      });
    } else if (data.amount) {
      result = await atomicGrant({
        userId: data.userId,
        amount: data.amount,
        type: 'REFUND',
        reason: data.reason,
        metadata: data.metadata,
        idempotencyKey,
        requestId: req.id,
        requestHash: deriveWriteRequestHash(req.body),
      });
    } else {
      return res.status(400).json({ error: 'amount or transactionId required' });
    }
    if (!result.ok) return sendWriteFailure(res, result);
    if (result.replay && result.cachedResponse) {
      return res
        .status(result.cachedResponse.statusCode)
        .json(result.cachedResponse.body);
    }
    const statusCode = result.replay ? 200 : 201;
    const responseBody = {
      transaction: serializeTransaction(result.txn),
      replay: !!result.replay,
    };
    if (!data.transactionId) {
      await persistWriteResponse(result, statusCode, responseBody);
    }
    return res.status(statusCode).json(responseBody);
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users/:userId', async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const row = await getCreditRow(req.params.userId);
    res.json({ credits: serializeCredits(row) });
  } catch (err) {
    next(err);
  }
});

module.exports = meRouter;
module.exports.adminRouter = adminRouter;
module.exports.SpendSchema = SpendSchema;
module.exports.GrantSchema = GrantSchema;
module.exports.RefundSchema = RefundSchema;
module.exports.atomicGrant = atomicGrant;
module.exports.atomicSpend = atomicSpend;
module.exports.ensureCreditRow = ensureCreditRow;
module.exports.getCreditRow = getCreditRow;
module.exports.persistWriteResponse = persistWriteResponse;
module.exports.serializeCredits = serializeCredits;
module.exports.serializeTransaction = serializeTransaction;
