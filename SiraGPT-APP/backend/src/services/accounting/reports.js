'use strict';

const { sum2, round2 } = require('./money');
const { accountElement } = require('./double-entry');
const ledger = require('./ledger');

/**
 * Reportes financieros derivados del Libro Mayor (asientos POSTED). Reconcilian
 * con los saldos del mayor: como todo asiento cumple Σdebe=Σhaber, se mantiene
 * la identidad contable  ACTIVO = PASIVO + PATRIMONIO + RESULTADO.
 *
 * Las filas de entrada son las de ledger.buildLedger/computeLedger:
 *   { code, name?, nature?, debit, credit, balance, count }
 * El elemento (clase PCGE) se deriva del primer dígito del código.
 */

function debitMinusCredit(rows, predicate) {
  return sum2(rows.filter(predicate).map((r) => round2((r.debit || 0) - (r.credit || 0))));
}
function creditMinusDebit(rows, predicate) {
  return sum2(rows.filter(predicate).map((r) => round2((r.credit || 0) - (r.debit || 0))));
}
const inElement = (...els) => (r) => els.includes(accountElement(r.code));

/** Estado de resultados: ingresos (elemento 7, neto) − gastos (elemento 6). */
function incomeStatement(rows) {
  const ingresos = creditMinusDebit(rows, inElement(7)); // 70 acreedora suma; 74 deudora resta
  const gastos = debitMinusCredit(rows, inElement(6));
  const utilidad = round2(ingresos - gastos);
  return { ingresos, gastos, utilidad };
}

/** Balance general: activo vs pasivo + patrimonio + resultado del ejercicio. */
function balanceSheet(rows) {
  const activo = debitMinusCredit(rows, inElement(1, 2, 3));
  const pasivo = creditMinusDebit(rows, inElement(4));
  const patrimonio = creditMinusDebit(rows, inElement(5));
  const { utilidad: resultado } = incomeStatement(rows);
  const pasivoPatrimonioYResultado = round2(pasivo + patrimonio + resultado);
  const difference = round2(activo - pasivoPatrimonioYResultado);
  return { activo, pasivo, patrimonio, resultado, pasivoPatrimonioYResultado, balanced: difference === 0, difference };
}

/** Flujo de caja: movimientos de cuentas de efectivo y equivalentes (clase 10). */
function cashFlow(rows) {
  const cash = rows.filter((r) => String(r.code).startsWith('10'));
  const entradas = sum2(cash.map((r) => r.debit || 0));
  const salidas = sum2(cash.map((r) => r.credit || 0));
  return { entradas, salidas, saldo: round2(entradas - salidas), cuentas: cash.map((r) => ({ code: r.code, name: r.name, saldo: r.balance })) };
}

// ── Prisma-backed ────────────────────────────────────────────────────────────
async function computeIncomeStatement({ prisma, from, to } = {}) {
  const rows = await ledger.computeLedger({ prisma, from, to });
  return { ...incomeStatement(rows), from: from || null, to: to || null };
}
async function computeBalanceSheet({ prisma, asOf } = {}) {
  const rows = await ledger.computeLedger({ prisma, to: asOf });
  return { ...balanceSheet(rows), asOf: asOf || null };
}
async function computeCashFlow({ prisma, from, to } = {}) {
  const rows = await ledger.computeLedger({ prisma, from, to });
  return { ...cashFlow(rows), from: from || null, to: to || null };
}

module.exports = {
  incomeStatement,
  balanceSheet,
  cashFlow,
  computeIncomeStatement,
  computeBalanceSheet,
  computeCashFlow,
};
