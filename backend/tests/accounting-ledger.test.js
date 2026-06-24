'use strict';

/**
 * Libro Mayor — agregación por cuenta, saldo según naturaleza y reconciliación
 * del balance de comprobación (Σdebe = Σhaber). Pure + fakePrisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../src/services/accounting/ledger');

const META = new Map([
  ['12', { name: 'CxC comerciales', nature: 'DEUDORA' }],
  ['70', { name: 'Ventas', nature: 'ACREEDORA' }],
  ['40', { name: 'Tributos por pagar', nature: 'ACREEDORA' }],
  ['10', { name: 'Efectivo', nature: 'DEUDORA' }],
]);

// Dos asientos: venta con IGV (118 = 100 + 18) y cobro (118).
const LINES = [
  { accountCode: '12', debit: 118, credit: 0 },
  { accountCode: '70', debit: 0, credit: 100 },
  { accountCode: '40', debit: 0, credit: 18 },
  { accountCode: '10', debit: 118, credit: 0 },
  { accountCode: '12', debit: 0, credit: 118 },
];

test('buildLedger: agrupa por cuenta y suma debe/haber', () => {
  const rows = ledger.buildLedger(LINES, META);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode['12'].debit, 118);
  assert.equal(byCode['12'].credit, 118);
  assert.equal(byCode['12'].count, 2);
  assert.equal(byCode['10'].debit, 118);
  assert.equal(byCode['70'].credit, 100);
});

test('buildLedger: saldo firmado por naturaleza', () => {
  const byCode = Object.fromEntries(ledger.buildLedger(LINES, META).map((r) => [r.code, r]));
  assert.equal(byCode['12'].balance, 0); // deudora: 118 - 118
  assert.equal(byCode['10'].balance, 118); // deudora: 118 - 0
  assert.equal(byCode['70'].balance, 100); // acreedora: 100 - 0
  assert.equal(byCode['40'].balance, 18); // acreedora: 18 - 0
});

test('buildTrialBalance: reconcilia Σdebe = Σhaber', () => {
  const tb = ledger.buildTrialBalance(LINES, META);
  assert.equal(tb.totalDebit, 236); // 118 + 118
  assert.equal(tb.totalCredit, 236); // 100 + 18 + 118
  assert.equal(tb.difference, 0);
  assert.equal(tb.balanced, true);
});

test('buildTrialBalance: detecta descuadre (datos corruptos)', () => {
  const tb = ledger.buildTrialBalance(
    [{ accountCode: '12', debit: 100, credit: 0 }, { accountCode: '70', debit: 0, credit: 90 }],
    META,
  );
  assert.equal(tb.balanced, false);
  assert.equal(tb.difference, 10);
});

test('buildLedger: redondeo exacto a 2 decimales', () => {
  const rows = ledger.buildLedger([
    { accountCode: '70', debit: 0, credit: 33.33 },
    { accountCode: '70', debit: 0, credit: 33.34 },
    { accountCode: '70', debit: 0, credit: 33.33 },
  ], META);
  assert.equal(rows[0].credit, 100.0);
  assert.equal(rows[0].balance, 100.0);
});

test('computeLedger / computeTrialBalance with fakePrisma (POSTED only)', async () => {
  const prisma = {
    accountingJournalLine: {
      findMany: async ({ where }) => {
        assert.equal(where.entry.status, 'POSTED'); // sólo asientos contabilizados
        return where.accountCode ? LINES.filter((l) => l.accountCode === where.accountCode) : LINES;
      },
    },
    accountingAccount: {
      findMany: async () => [...META.entries()].map(([code, m]) => ({ code, name: m.name, nature: m.nature })),
    },
  };
  const all = await ledger.computeLedger({ prisma });
  assert.equal(all.length, 4);
  const cta12 = await ledger.computeLedger({ prisma, accountCode: '12' });
  assert.equal(cta12.code, '12');
  assert.equal(cta12.balance, 0);
  const tb = await ledger.computeTrialBalance({ prisma });
  assert.equal(tb.balanced, true);
  assert.equal(tb.totalDebit, 236);
});
