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

// `$queryRaw` maps Postgres int8 to BigInt, but a value can arrive as a string
// under some drivers/mocks — coerce defensively so `balanceAfter` is always a
// BigInt matching the column type.
function toBigIntBalance(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) return 0n;
  try { return BigInt(typeof value === 'number' ? Math.trunc(value) : value); }
  catch { return 0n; }
}

function pickIdempotencyKey(req) {
  return (
    req.get?.('Idempotency-Key') ||
    req.get?.('idempotency-key') ||
    req.body?.idempotencyKey ||
    null
  );
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

/**
 * Atomically spend `amount` credits for `userId` against the new
 * credits ledger. Returns either:
 *   { ok: true, replay?: true, txn: <CreditTransaction> }
 * or:
 *   { ok: false, code: 'INSUFFICIENT' | 'INVALID_AMOUNT' }
 */
async function spendCredits({ userId, amount, feature, reason, metadata, idempotencyKey }) {
  // Coerce to a non-negative integer BigInt at the chokepoint. `BigInt()` throws
  // RangeError on a fractional Number, so round UP first (never under-charge);
  // a non-finite / non-positive amount is rejected cleanly as INVALID_AMOUNT
  // instead of crashing the caller with a 500.
  let amt;
  if (typeof amount === 'bigint') {
    amt = amount;
  } else {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, code: 'INVALID_AMOUNT' };
    }
    amt = BigInt(Math.ceil(n));
  }
  if (!userId || amt <= 0n) {
    return { ok: false, code: 'INVALID_AMOUNT' };
  }

  if (idempotencyKey) {
    const existing = await prisma.creditTransaction.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return { ok: true, replay: true, txn: existing };
  }

  // Atomic guarded debit. `RETURNING "balance"` captures the post-debit balance
  // in the SAME statement, so the ledger's `balanceAfter` reflects exactly this
  // transaction's result — a separate re-read could observe a concurrent
  // spend/refund and record a balance that never corresponded to this txn.
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
  const balanceAfter = toBigIntBalance(rows[0].balance);
  const txn = await prisma.creditTransaction.create({
    data: {
      userId,
      type: 'SPEND',
      amount: -amt,
      balanceAfter,
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
  // `update` issues an atomic UPDATE … RETURNING; use its returned balance
  // directly so `balanceAfter` matches this refund's result rather than a
  // separately-read snapshot that a concurrent write could have shifted.
  const after = await prisma.credit.update({
    where: { userId: originalTxn.userId },
    data: {
      balance: { increment: absAmt },
      lifetimeSpent: { decrement: absAmt },
    },
  });
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
  const {
    feature,
    cost,
    reason,
    metadata,
    allowFreeIaFallback = true,
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
  // never refund a replay, and never refund a fallback (no txn was
  // recorded — the request bypassed the ledger entirely)
  if (!charge || charge.replay || !charge.txn || charge.fallback) return null;
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
