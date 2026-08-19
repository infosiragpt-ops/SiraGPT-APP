'use strict';

const { sum2, round2 } = require('./money');

/**
 * Libro Mayor — saldos por cuenta derivados de las líneas del diario.
 * El saldo se firma según la naturaleza de la cuenta:
 *   - DEUDORA  → saldo = debe − haber
 *   - ACREEDORA → saldo = haber − debe
 */

/**
 * Pure aggregation: agrupa líneas por cuenta y calcula debe/haber/saldo.
 * @param {Array<{accountCode:string, debit?:number, credit?:number}>} lines
 * @param {Map<string,{name?:string,nature?:string}>} accountMeta
 * @returns {Array<{code,name,nature,debit,credit,balance,count}>}
 */
function buildLedger(lines, accountMeta = new Map()) {
  const groups = new Map();
  for (const l of Array.isArray(lines) ? lines : []) {
    const code = l.accountCode;
    if (!groups.has(code)) {
      const meta = accountMeta.get(code) || {};
      groups.set(code, { code, name: meta.name || null, nature: meta.nature || 'DEUDORA', debit: 0, credit: 0, count: 0 });
    }
    const g = groups.get(code);
    g.debit = sum2([g.debit, l.debit || 0]);
    g.credit = sum2([g.credit, l.credit || 0]);
    g.count += 1;
  }
  const rows = [...groups.values()].map((g) => ({
    ...g,
    balance: g.nature === 'ACREEDORA' ? round2(g.credit - g.debit) : round2(g.debit - g.credit),
  }));
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return rows;
}

/**
 * Balance de comprobación (sumas y saldos): totales de debe y haber por cuenta.
 * `balanced` confirma la reconciliación contable Σdebe = Σhaber.
 */
function buildTrialBalance(lines, accountMeta = new Map()) {
  const accounts = buildLedger(lines, accountMeta);
  const totalDebit = sum2(accounts.map((a) => a.debit));
  const totalCredit = sum2(accounts.map((a) => a.credit));
  return {
    accounts,
    totalDebit,
    totalCredit,
    difference: round2(totalDebit - totalCredit),
    balanced: round2(totalDebit - totalCredit) === 0,
  };
}

// ── Prisma-backed wrappers ───────────────────────────────────────────────────

async function loadPostedLines(prisma, { accountCode, from, to } = {}) {
  const where = { entry: { status: 'POSTED' } };
  if (accountCode) where.accountCode = accountCode;
  if (from || to) {
    where.entry.date = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  }
  return prisma.accountingJournalLine.findMany({
    where,
    select: { accountCode: true, debit: true, credit: true, entryId: true },
  });
}

async function accountMetaMap(prisma, codes) {
  const rows = await prisma.accountingAccount.findMany({
    where: codes ? { code: { in: [...new Set(codes)] } } : {},
    select: { code: true, name: true, nature: true },
  });
  return new Map(rows.map((r) => [r.code, { name: r.name, nature: r.nature }]));
}

/** Mayor de una cuenta (o de todas) en un rango, derivado de asientos POSTED. */
async function computeLedger({ prisma, accountCode, from, to } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const lines = await loadPostedLines(prisma, { accountCode, from, to });
  const meta = await accountMetaMap(prisma, lines.map((l) => l.accountCode));
  const accounts = buildLedger(lines, meta);
  return accountCode ? (accounts[0] || { code: accountCode, debit: 0, credit: 0, balance: 0, count: 0 }) : accounts;
}

/** Balance de comprobación del libro mayor (reconcilia con el diario). */
async function computeTrialBalance({ prisma, from, to } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const lines = await loadPostedLines(prisma, { from, to });
  const meta = await accountMetaMap(prisma, lines.map((l) => l.accountCode));
  return buildTrialBalance(lines, meta);
}

module.exports = {
  buildLedger,
  buildTrialBalance,
  loadPostedLines,
  accountMetaMap,
  computeLedger,
  computeTrialBalance,
};
