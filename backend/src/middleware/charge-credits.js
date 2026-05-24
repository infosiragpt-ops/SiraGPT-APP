'use strict';

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
 * On insufficient credits: 402 `insufficient credits`. No transaction
 * is written. The request never reaches the handler.
 *
 * Idempotency: honours `Idempotency-Key` header (or body field) — a
 * replay returns the existing transaction without double-charging.
 */

const prisma = require('../config/database');

function pickIdempotencyKey(req) {
  return (
    req.get?.('Idempotency-Key') ||
    req.get?.('idempotency-key') ||
    req.body?.idempotencyKey ||
    null
  );
}

function resolveCost(spec, req) {
  if (typeof spec === 'function') return spec(req);
  if (typeof spec === 'number') return spec;
  if (typeof spec === 'string' && /^\d+$/.test(spec)) return Number(spec);
  return 0;
}

/**
 * Atomically spend `amount` credits for `userId` against the new
 * credits ledger. Returns either:
 *   { ok: true, replay?: true, txn: <CreditTransaction> }
 * or:
 *   { ok: false, code: 'INSUFFICIENT' | 'INVALID_AMOUNT' }
 */
async function spendCredits({ userId, amount, feature, reason, metadata, idempotencyKey }) {
  if (!userId || !amount || amount <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT' };
  }
  const amt = typeof amount === 'bigint' ? amount : BigInt(amount);

  if (idempotencyKey) {
    const existing = await prisma.creditTransaction.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return { ok: true, replay: true, txn: existing };
  }

  // Atomic guarded debit.
  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "credits"
       SET "balance" = "balance" - $1::BIGINT,
           "lifetimeSpent" = "lifetimeSpent" + $1::BIGINT,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "userId" = $2
       AND "balance" >= $1::BIGINT`,
    amt.toString(),
    userId,
  );
  if (affected === 0) {
    return { ok: false, code: 'INSUFFICIENT' };
  }
  const after = await prisma.credit.findUnique({ where: { userId } });
  const txn = await prisma.creditTransaction.create({
    data: {
      userId,
      type: 'SPEND',
      amount: -amt,
      balanceAfter: after.balance,
      reason: reason || `spend(${feature})`,
      metadata: { feature, ...(metadata || {}) },
      idempotencyKey: idempotencyKey || null,
    },
  });
  return { ok: true, txn };
}

/**
 * Reverse a previously-recorded SPEND by issuing a REFUND of the same
 * absolute amount and crediting the balance back. Used in error paths
 * (`refundLastCharge(req, reason)`) so a 5xx from the downstream LLM
 * doesn't drain user credits.
 */
async function refundCharge({ originalTxn, reason, metadata }) {
  if (!originalTxn) return { ok: false, code: 'NO_TXN' };
  const absAmt = originalTxn.amount < 0n ? -originalTxn.amount : originalTxn.amount;
  await prisma.credit.update({
    where: { userId: originalTxn.userId },
    data: {
      balance: { increment: absAmt },
      lifetimeSpent: { decrement: absAmt },
    },
  });
  const after = await prisma.credit.findUnique({ where: { userId: originalTxn.userId } });
  const txn = await prisma.creditTransaction.create({
    data: {
      userId: originalTxn.userId,
      type: 'REFUND',
      amount: absAmt,
      balanceAfter: after.balance,
      reason: reason || `refund(${originalTxn.id})`,
      metadata: { ...(originalTxn.metadata || {}), refundedTxnId: originalTxn.id, ...(metadata || {}) },
    },
  });
  return { ok: true, txn };
}

/**
 * Middleware factory.
 */
function chargeCredits(spec = {}) {
  const { feature, cost, reason, metadata } = spec;
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
      const idempotencyKey = pickIdempotencyKey(req);
      const result = await spendCredits({
        userId: req.user.id,
        amount,
        feature,
        reason,
        metadata: typeof metadata === 'function' ? metadata(req) : metadata,
        idempotencyKey,
      });
      if (!result.ok) {
        if (result.code === 'INSUFFICIENT') {
          return res.status(402).json({
            error: 'insufficient credits',
            feature,
            costRequested: String(amount),
          });
        }
        return res.status(400).json({ error: 'invalid charge amount' });
      }
      req._chargedCredits = {
        feature,
        amount,
        txn: result.txn,
        replay: !!result.replay,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Convenience helper for route handlers — refund the most recent
 * charge attached to the request. No-op if no charge is recorded.
 */
async function refundLastCharge(req, reason) {
  const charge = req._chargedCredits;
  if (!charge || charge.replay) return null; // never refund a replay
  try {
    const result = await refundCharge({
      originalTxn: charge.txn,
      reason: reason || `auto-refund(${charge.feature})`,
    });
    req._refundedCredits = result;
    return result;
  } catch (err) {
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
