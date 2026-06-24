'use strict';

/**
 * accounting/correlative — transparent retry for correlative (sequential)
 * numbering.
 *
 * Invoice and journal-entry numbers are assigned read-then-write
 * (`SELECT max(number) + 1` then `INSERT`). The database unique constraints
 * (`AccountingJournalEntry.number @unique`, `AccountingInvoice @@unique([series,
 * number])`) guarantee no two rows ever share a number — but under concurrency
 * two creates compute the same next number and the loser's INSERT fails with
 * Prisma P2002 instead of simply taking the next slot. This helper re-runs the
 * compute+insert on a unique violation so the loser transparently re-numbers
 * rather than surfacing a spurious error to the caller.
 */

const DEFAULT_MAX_RETRIES = (() => {
  const n = Number(process.env.SIRAGPT_CORRELATIVE_MAX_RETRIES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
})();

/** True when `err` is a Prisma unique-constraint violation (P2002). */
function isUniqueViolation(err) {
  return Boolean(err) && err.code === 'P2002';
}

/**
 * Run `create(attempt)` — which must recompute the next number and insert —
 * retrying on a unique-constraint violation up to `attempts` times. Any other
 * error (or exhausting the retries) propagates unchanged.
 * @param {(attempt:number)=>Promise<any>} create
 * @param {{attempts?:number}} [opts]
 */
async function withCorrelativeRetry(create, { attempts = DEFAULT_MAX_RETRIES } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await create(attempt);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < attempts) continue;
      throw err;
    }
  }
}

module.exports = { withCorrelativeRetry, isUniqueViolation, DEFAULT_MAX_RETRIES };
