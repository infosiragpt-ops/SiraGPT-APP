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
const prisma = require('../config/database');

const meRouter = express.Router();
const adminRouter = express.Router();

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
function toBigInt(value) {
  return typeof value === 'bigint' ? value : BigInt(value);
}

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

async function findByIdempotency(idempotencyKey) {
  if (!idempotencyKey) return null;
  return prisma.creditTransaction.findUnique({
    where: { idempotencyKey },
  });
}

async function ensureCreditRow(userId) {
  let row = await prisma.credit.findUnique({ where: { userId } });
  if (row) return row;
  row = await prisma.credit.create({
    data: {
      userId,
      balance: BigInt(0),
      reservedBalance: BigInt(0),
      lifetimeGranted: BigInt(0),
      lifetimeSpent: BigInt(0),
    },
  });
  return row;
}

// Atomic spend. Returns either { ok: true, balanceAfter, txn } or
// { ok: false, code: 'INSUFFICIENT' }.
async function atomicSpend({ userId, amount, feature, reason, metadata, idempotencyKey }) {
  const amt = toBigInt(amount);

  // Idempotent replay short-circuit.
  if (idempotencyKey) {
    const existing = await findByIdempotency(idempotencyKey);
    if (existing) {
      return { ok: true, replay: true, txn: existing };
    }
  }

  // Atomic guarded UPDATE — only succeeds if balance is sufficient. Capture the
  // post-debit balance in the SAME statement via RETURNING so the ledger's
  // balanceAfter reflects exactly this transaction (a separate findUnique could
  // observe a concurrent spend/grant and record a balance that never matched
  // this debit). Mirrors middleware/charge-credits.js.
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "credits"
       SET "balance" = "balance" - $1::BIGINT,
           "lifetimeSpent" = "lifetimeSpent" + $1::BIGINT,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "userId" = $2
       AND "balance" >= $1::BIGINT
     RETURNING "balance"`,
    amt.toString(),
    userId,
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, code: 'INSUFFICIENT' };
  }
  const balanceAfter = BigInt(rows[0].balance);
  const txn = await prisma.creditTransaction.create({
    data: {
      userId,
      type: 'SPEND',
      amount: -amt, // ledger convention: negative for debits
      balanceAfter,
      reason: reason || `spend(${feature})`,
      metadata: { feature, ...(metadata || {}) },
      idempotencyKey: idempotencyKey || null,
    },
  });
  return { ok: true, balanceAfter, txn };
}

async function atomicGrant({ userId, amount, type, reason, metadata, idempotencyKey }) {
  const amt = toBigInt(amount);
  if (idempotencyKey) {
    const existing = await findByIdempotency(idempotencyKey);
    if (existing) return { replay: true, txn: existing };
  }
  await ensureCreditRow(userId);
  // Use the row returned by the atomic increment as balanceAfter rather than a
  // follow-up findUnique that a concurrent write could race.
  const updated = await prisma.credit.update({
    where: { userId },
    data: {
      balance: { increment: amt },
      lifetimeGranted: { increment: amt },
    },
  });
  const balanceAfter = updated.balance;
  const txn = await prisma.creditTransaction.create({
    data: {
      userId,
      type,
      amount: amt,
      balanceAfter,
      reason,
      metadata: metadata || {},
      idempotencyKey: idempotencyKey || null,
    },
  });
  return { balanceAfter, txn };
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
    const cursor = req.query.cursor ? { id: String(req.query.cursor) } : undefined;
    const typeFilter = req.query.type ? { type: String(req.query.type) } : {};
    const items = await prisma.creditTransaction.findMany({
      where: { userId: req.user.id, ...typeFilter },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor && { skip: 1, cursor }),
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
    const result = await atomicSpend({ ...data, idempotencyKey });
    if (!result.ok) {
      return res.status(402).json({ error: 'insufficient credits' });
    }
    res.status(result.replay ? 200 : 201).json({
      transaction: serializeTransaction(result.txn),
      replay: !!result.replay,
    });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(200).json({ error: 'replay', code: 'idempotency_conflict' });
    }
    next(err);
  }
});

// ── Admin routes ───────────────────────────────────────────────────
adminRouter.post('/grant', authenticateToken, async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
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
    });
    res.status(result.replay ? 200 : 201).json({
      transaction: serializeTransaction(result.txn),
      replay: !!result.replay,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/refund', authenticateToken, async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const parse = RefundSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'invalid payload', issues: parse.error.issues });
    }
    const data = parse.data;
    const idempotencyKey = pickIdempotencyKey(req, data.idempotencyKey);
    // Refund amount: explicit if provided, otherwise pull from the
    // referenced transaction (must exist + must be a SPEND).
    let amount = data.amount;
    if (!amount) {
      if (!data.transactionId) {
        return res.status(400).json({ error: 'amount or transactionId required' });
      }
      const original = await prisma.creditTransaction.findUnique({
        where: { id: data.transactionId },
      });
      if (!original || original.userId !== data.userId) {
        return res.status(404).json({ error: 'transaction not found for user' });
      }
      if (original.type !== 'SPEND') {
        return res.status(400).json({ error: 'can only refund SPEND transactions' });
      }
      amount = (-original.amount).toString();
    }
    const result = await atomicGrant({
      userId: data.userId,
      amount,
      type: 'REFUND',
      reason: data.reason,
      metadata: { transactionId: data.transactionId, ...(data.metadata || {}) },
      idempotencyKey,
    });
    res.status(result.replay ? 200 : 201).json({
      transaction: serializeTransaction(result.txn),
      replay: !!result.replay,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/users/:userId', authenticateToken, async (req, res, next) => {
  try {
    if (!requireSuperAdmin(req, res)) return;
    const row = await prisma.credit.findUnique({ where: { userId: req.params.userId } });
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
module.exports.serializeCredits = serializeCredits;
module.exports.serializeTransaction = serializeTransaction;
