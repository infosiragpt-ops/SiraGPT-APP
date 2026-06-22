'use strict';

const { z } = require('zod');
const { assertBalanced } = require('./double-entry');
const { assertDateOpen } = require('./periods');
const { round2, round6 } = require('./money');

/** Zod schema para una línea de asiento. */
const journalLineSchema = z.object({
  accountCode: z.string().trim().min(1, 'accountCode requerido').max(12),
  debit: z.coerce.number().nonnegative().default(0),
  credit: z.coerce.number().nonnegative().default(0),
  description: z.string().trim().max(500).optional(),
});

/** Zod schema para el alta de un asiento del libro diario. */
const journalEntryInputSchema = z.object({
  date: z.coerce.date().default(() => new Date()),
  glosa: z.string().trim().min(1, 'glosa requerida').max(500),
  currency: z.enum(['PEN', 'USD']).default('PEN'),
  exchangeRate: z.coerce.number().positive().optional(),
  source: z.enum(['MANUAL', 'SALE', 'PAYMENT', 'OPENING', 'CLOSING']).default('MANUAL'),
  sourceId: z.string().trim().max(64).optional(),
  periodId: z.string().trim().max(64).optional(),
  lines: z.array(journalLineSchema).min(2, 'Un asiento requiere al menos 2 líneas'),
}).superRefine((val, ctx) => {
  if (val.currency !== 'PEN' && !val.exchangeRate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchangeRate'], message: 'exchangeRate requerido cuando currency != PEN' });
  }
});

/** Validate + normalize input through zod, returning the parsed value or throwing a typed error. */
function parseJournalEntryInput(input) {
  const result = journalEntryInputSchema.safeParse(input);
  if (!result.success) {
    const err = new Error('Entrada de asiento inválida');
    err.code = 'VALIDATION_ERROR';
    err.issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw err;
  }
  return result.data;
}

/**
 * Resolve account codes → { id, postable } and ensure they all exist & are active.
 * @returns {Promise<Map<string,{id:string,postable:boolean}>>}
 */
async function resolveAccounts(prisma, codes) {
  const unique = [...new Set(codes)];
  const rows = await prisma.accountingAccount.findMany({
    where: { code: { in: unique }, isActive: true },
    select: { id: true, code: true, postable: true },
  });
  const byCode = new Map(rows.map((r) => [r.code, { id: r.id, postable: r.postable }]));
  const missing = unique.filter((c) => !byCode.has(c));
  if (missing.length) {
    const err = new Error(`Cuentas inexistentes o inactivas: ${missing.join(', ')}`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.missing = missing;
    throw err;
  }
  return byCode;
}

/** Next correlative journal number (global). */
async function nextEntryNumber(prisma) {
  const last = await prisma.accountingJournalEntry.findFirst({
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  return (last && last.number ? last.number : 0) + 1;
}

/**
 * Create a posted double-entry journal entry. Enforces Σdebe=Σhaber, resolves
 * account codes, assigns a correlative number, persists entry + lines atomically.
 * @param {object} args { prisma, input, userId? }
 */
async function createJournalEntry({ prisma, input, userId = null } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parseJournalEntryInput(input);

  // Invariante contable: el total del debe debe ser igual al del haber.
  assertBalanced(data.lines);

  // No se permiten asientos en un periodo contable cerrado.
  const period = await assertDateOpen({ prisma, date: data.date });

  const byCode = await resolveAccounts(prisma, data.lines.map((l) => l.accountCode));
  const number = await nextEntryNumber(prisma);

  const lines = data.lines.map((l) => ({
    accountId: byCode.get(l.accountCode).id,
    accountCode: l.accountCode,
    debit: round2(l.debit || 0),
    credit: round2(l.credit || 0),
    description: l.description || null,
  }));

  return prisma.accountingJournalEntry.create({
    data: {
      number,
      date: data.date,
      glosa: data.glosa,
      currency: data.currency,
      exchangeRate: data.exchangeRate != null ? round6(data.exchangeRate) : null,
      status: 'POSTED',
      source: data.source,
      sourceId: data.sourceId || null,
      periodId: data.periodId || (period ? period.id : null),
      userId,
      lines: { create: lines },
    },
    include: { lines: true },
  });
}

/** List journal entries (paginated, newest first), optionally filtered. */
async function listJournalEntries({ prisma, status, source, from, to, skip = 0, take = 50 } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const where = {};
  if (status) where.status = status;
  if (source) where.source = source;
  if (from || to) where.date = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  const [items, total] = await Promise.all([
    prisma.accountingJournalEntry.findMany({ where, orderBy: { number: 'desc' }, skip, take, include: { lines: true } }),
    prisma.accountingJournalEntry.count({ where }),
  ]);
  return { items, total, skip, take };
}

async function getJournalEntry({ prisma, id } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  return prisma.accountingJournalEntry.findUnique({ where: { id }, include: { lines: true } });
}

module.exports = {
  journalLineSchema,
  journalEntryInputSchema,
  parseJournalEntryInput,
  resolveAccounts,
  nextEntryNumber,
  createJournalEntry,
  listJournalEntries,
  getJournalEntry,
};
