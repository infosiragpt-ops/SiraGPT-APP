'use strict';

/**
 * Exact 2-decimal money helpers (integer-cents) — no float drift, no extra deps.
 * Accounting and IGV math MUST be exact; never compare/round raw floats.
 * Accepts numbers, numeric strings, or Prisma.Decimal-like objects (toString).
 */

function toNumber(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof value.toString === 'function') {
    const n = Number(value.toString());
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round a money value to integer cents (half-up). */
function toCents(value) {
  const n = toNumber(value);
  // +1e-9 nudge guards against binary-fp values like 0.005 landing just below.
  return Math.round((n + (n >= 0 ? 1e-9 : -1e-9)) * 100);
}

function fromCents(cents) {
  return Math.round(cents) / 100;
}

/** Round any value to exactly 2 decimals (Peruvian money convention). */
function round2(value) {
  return fromCents(toCents(value));
}

/**
 * Round to 6 decimals — exchange-rate precision (the rate column is
 * Decimal(18,6)). Using round2 (money precision) on a stored FX rate corrupts
 * every conversion. round2 is for money AMOUNTS; round6 is for FX RATES.
 */
function round6(value) {
  return Math.round(toNumber(value) * 1e6) / 1e6;
}

function sumCents(values) {
  return (Array.isArray(values) ? values : []).reduce((acc, v) => acc + toCents(v), 0);
}

/** Sum a list of money values exactly, returning a 2-decimal number. */
function sum2(values) {
  return fromCents(sumCents(values));
}

/** True when two money values are equal to the cent. */
function eqMoney(a, b) {
  return toCents(a) === toCents(b);
}

module.exports = { toNumber, toCents, fromCents, round2, round6, sumCents, sum2, eqMoney };
