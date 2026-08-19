'use strict';

const { z } = require('zod');

/**
 * Periodos contables mensuales con apertura/cierre. Un periodo CERRADO bloquea
 * el alta de asientos cuya fecha caiga dentro de él.
 */

const periodInputSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

function parsePeriodInput(input) {
  const r = periodInputSchema.safeParse(input);
  if (!r.success) {
    const err = new Error('Periodo inválido (year/month)');
    err.code = 'VALIDATION_ERROR';
    err.issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw err;
  }
  return r.data;
}

/** UTC start/end (inclusive) of a calendar month. */
function monthBounds(year, month) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)); // day 0 of next month = last day
  return { startDate, endDate };
}

function yearMonthOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Open (or create) a monthly period. Idempotent. */
async function openPeriod({ prisma, input } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const { year, month } = parsePeriodInput(input);
  const { startDate, endDate } = monthBounds(year, month);
  return prisma.accountingPeriod.upsert({
    where: { year_month: { year, month } },
    update: { status: 'OPEN', closedAt: null, closedBy: null },
    create: { year, month, startDate, endDate, status: 'OPEN' },
  });
}

/** Close a monthly period. Creates it (closed) if it didn't exist. */
async function closePeriod({ prisma, input, closedBy = null } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const { year, month } = parsePeriodInput(input);
  const { startDate, endDate } = monthBounds(year, month);
  const closedAt = new Date();
  return prisma.accountingPeriod.upsert({
    where: { year_month: { year, month } },
    update: { status: 'CLOSED', closedAt, closedBy },
    create: { year, month, startDate, endDate, status: 'CLOSED', closedAt, closedBy },
  });
}

/** Find the period that contains a given date (by year/month). */
async function findPeriodForDate({ prisma, date } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const { year, month } = yearMonthOf(date);
  return prisma.accountingPeriod.findUnique({ where: { year_month: { year, month } } });
}

/**
 * Throw PERIOD_CLOSED if the date falls in an existing CLOSED period.
 * If no period exists for that month, posting is allowed (periodos opcionales
 * hasta que se crean/cierran explícitamente). Gracefully skips when the model
 * isn't available on the injected client (compat con tests sin este modelo).
 * @returns {Promise<object|null>} the period (or null) when posting is allowed.
 */
async function assertDateOpen({ prisma, date } = {}) {
  if (!prisma || !prisma.accountingPeriod) return null;
  const period = await findPeriodForDate({ prisma, date });
  if (period && period.status === 'CLOSED') {
    const err = new Error(`El periodo ${period.year}-${String(period.month).padStart(2, '0')} está cerrado; no se pueden registrar asientos en él.`);
    err.code = 'PERIOD_CLOSED';
    err.period = { year: period.year, month: period.month };
    throw err;
  }
  return period || null;
}

async function listPeriods({ prisma } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  return prisma.accountingPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
}

module.exports = {
  periodInputSchema,
  parsePeriodInput,
  monthBounds,
  yearMonthOf,
  openPeriod,
  closePeriod,
  findPeriodForDate,
  assertDateOpen,
  listPeriods,
};
