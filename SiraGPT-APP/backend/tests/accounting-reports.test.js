'use strict';

/**
 * Reportes financieros — estado de resultados, balance general (reconcilia
 * activo = pasivo + patrimonio + resultado) y flujo de caja. Derivados del
 * mayor (ledger.buildLedger), garantizando cuadre con asientos balanceados.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reports = require('../src/services/accounting/reports');
const ledger = require('../src/services/accounting/ledger');

const META = new Map([
  ['1011', { name: 'Caja', nature: 'DEUDORA' }],
  ['1212', { name: 'CxC', nature: 'DEUDORA' }],
  ['40111', { name: 'IGV por pagar', nature: 'ACREEDORA' }],
  ['7011', { name: 'Ventas', nature: 'ACREEDORA' }],
  ['6011', { name: 'Compras', nature: 'DEUDORA' }],
  ['50', { name: 'Capital', nature: 'ACREEDORA' }],
]);

// Venta 118 (100 + IGV 18), cobro 118, gasto 100 pagado en efectivo, capital aporte 500.
const LINES = [
  // aporte de capital inicial
  { accountCode: '1011', debit: 500, credit: 0 },
  { accountCode: '50', debit: 0, credit: 500 },
  // venta
  { accountCode: '1212', debit: 118, credit: 0 },
  { accountCode: '7011', debit: 0, credit: 100 },
  { accountCode: '40111', debit: 0, credit: 18 },
  // cobro
  { accountCode: '1011', debit: 118, credit: 0 },
  { accountCode: '1212', debit: 0, credit: 118 },
  // gasto pagado en efectivo
  { accountCode: '6011', debit: 100, credit: 0 },
  { accountCode: '1011', debit: 0, credit: 100 },
];

const rows = ledger.buildLedger(LINES, META);

test('incomeStatement: utilidad = ingresos − gastos', () => {
  const is = reports.incomeStatement(rows);
  assert.equal(is.ingresos, 100);
  assert.equal(is.gastos, 100);
  assert.equal(is.utilidad, 0);
});

test('incomeStatement: net de contra-ingreso (74 descuentos concedidos)', () => {
  const r = ledger.buildLedger([
    { accountCode: '7011', debit: 0, credit: 1000 },
    { accountCode: '74', debit: 200, credit: 0 },
  ], new Map([['7011', { nature: 'ACREEDORA' }], ['74', { nature: 'DEUDORA' }]]));
  // ingresos = (1000-0) + (0-200) = 800
  assert.equal(reports.incomeStatement(r).ingresos, 800);
});

test('balanceSheet: reconcilia activo = pasivo + patrimonio + resultado', () => {
  const bs = reports.balanceSheet(rows);
  // activo = caja(500+118-100=518) + CxC(0) = 518
  assert.equal(bs.activo, 518);
  assert.equal(bs.pasivo, 18); // IGV por pagar
  assert.equal(bs.patrimonio, 500); // capital
  assert.equal(bs.resultado, 0); // utilidad
  assert.equal(bs.pasivoPatrimonioYResultado, 518);
  assert.equal(bs.balanced, true);
  assert.equal(bs.difference, 0);
});

test('balanceSheet: con utilidad positiva sigue cuadrando', () => {
  // venta sin gasto: activo crece, resultado = utilidad
  const r = ledger.buildLedger([
    { accountCode: '1011', debit: 118, credit: 0 },
    { accountCode: '7011', debit: 0, credit: 100 },
    { accountCode: '40111', debit: 0, credit: 18 },
  ], META);
  const bs = reports.balanceSheet(r);
  assert.equal(bs.activo, 118);
  assert.equal(bs.resultado, 100);
  assert.equal(bs.pasivo, 18);
  assert.equal(bs.balanced, true); // 118 = 18 + 0 + 100
});

test('cashFlow: entradas/salidas/saldo de cuentas de efectivo (clase 10)', () => {
  const cf = reports.cashFlow(rows);
  assert.equal(cf.entradas, 618); // 500 + 118
  assert.equal(cf.salidas, 100); // gasto
  assert.equal(cf.saldo, 518);
});

test('computeBalanceSheet (fakePrisma) reconcilia', async () => {
  const prisma = {
    accountingJournalLine: { findMany: async ({ where }) => { assert.equal(where.entry.status, 'POSTED'); return LINES.map((l) => ({ ...l })); } },
    accountingAccount: { findMany: async () => [...META.entries()].map(([code, m]) => ({ code, name: m.name, nature: m.nature })) },
  };
  const bs = await reports.computeBalanceSheet({ prisma });
  assert.equal(bs.balanced, true);
  assert.equal(bs.activo, 518);
  const is = await reports.computeIncomeStatement({ prisma });
  assert.equal(is.utilidad, 0);
  const cf = await reports.computeCashFlow({ prisma });
  assert.equal(cf.saldo, 518);
});
