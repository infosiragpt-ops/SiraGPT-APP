'use strict';

const { z } = require('zod');
const { round2 } = require('./money');

// Exchange rates are stored at Decimal(18,6) precision — SBS/SUNAT publish
// rates like 3.751 / 3.7234. round2 (money precision) must NOT be used on the
// stored rate or every PEN conversion is corrupted; round2 stays on conversion
// RESULTS only (convertWithRate).
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

/**
 * Tipo de cambio (TC): soles PEN por 1 unidad de moneda extranjera.
 * convert(amount, rate, toPen): extranjera→PEN = amount * rate; PEN→extranjera = amount / rate.
 */

const rateInputSchema = z.object({
  date: z.coerce.date().default(() => new Date()),
  currency: z.string().trim().min(3).max(3).transform((s) => s.toUpperCase()),
  rate: z.coerce.number().positive(),
  rateType: z.enum(['COMPRA', 'VENTA']).default('VENTA'),
  source: z.enum(['MANUAL', 'SUNAT', 'SBS']).default('MANUAL'),
});

function parseRateInput(input) {
  const r = rateInputSchema.safeParse(input);
  if (!r.success) {
    const err = new Error('Tipo de cambio inválido');
    err.code = 'VALIDATION_ERROR';
    err.issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw err;
  }
  return r.data;
}

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/** Convert exactly between PEN and a foreign currency given the rate. */
function convertWithRate(amount, rate, toPen = true) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    const err = new Error('Tipo de cambio inválido para la conversión');
    err.code = 'INVALID_RATE';
    throw err;
  }
  const a = Number(amount) || 0;
  return round2(toPen ? a * r : a / r);
}

/** Record (upsert) a rate for a (date, currency, rateType). */
async function recordRate({ prisma, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parseRateInput(input);
  const date = dayKey(data.date);
  return prisma.accountingExchangeRate.upsert({
    where: { date_currency_rateType: { date, currency: data.currency, rateType: data.rateType } },
    update: { rate: round6(data.rate), source: data.source },
    create: { date, currency: data.currency, rate: round6(data.rate), rateType: data.rateType, source: data.source },
  });
}

/**
 * Get the rate for a currency on a date: exact-day match, else the most recent
 * rate on or before that date. Returns the rate (number) or null.
 */
async function getRate({ prisma, currency, date = new Date(), rateType = 'VENTA' } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const cur = String(currency || '').toUpperCase();
  const onOrBefore = dayKey(date);
  const row = await prisma.accountingExchangeRate.findFirst({
    where: { currency: cur, rateType, date: { lte: onOrBefore } },
    orderBy: { date: 'desc' },
  });
  return row ? Number(row.rate) : null;
}

/** Convenience: convert an amount using the stored rate for currency/date. */
async function convertAmount({ prisma, amount, currency, date = new Date(), rateType = 'VENTA', toPen = true } = {}) {
  const rate = await getRate({ prisma, currency, date, rateType });
  if (rate == null) {
    const err = new Error(`No hay tipo de cambio registrado para ${currency} al ${dayKey(date).toISOString().slice(0, 10)}`);
    err.code = 'RATE_NOT_FOUND';
    throw err;
  }
  return { amount: convertWithRate(amount, rate, toPen), rate };
}

async function listRates({ prisma, currency } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const where = currency ? { currency: String(currency).toUpperCase() } : {};
  return prisma.accountingExchangeRate.findMany({ where, orderBy: { date: 'desc' }, take: 200 });
}

module.exports = {
  rateInputSchema,
  parseRateInput,
  dayKey,
  convertWithRate,
  recordRate,
  getRate,
  convertAmount,
  listRates,
};
