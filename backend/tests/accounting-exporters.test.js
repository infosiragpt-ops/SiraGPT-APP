'use strict';

/**
 * Exportadores Excel/PDF del módulo contable. Verifica que los buffers se
 * generan, que los XLSX son re-leíbles con exceljs (cabeceras + filas) y que
 * los PDF son válidos (firma %PDF).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const exporters = require('../src/services/accounting/exporters');

const entries = [
  { number: 1, date: new Date('2026-06-15'), glosa: 'Venta', lines: [
    { accountCode: '1212', debit: 118, credit: 0 },
    { accountCode: '7011', debit: 0, credit: 100 },
    { accountCode: '40111', debit: 0, credit: 18 },
  ] },
];

test('journalWorkbookBuffer: XLSX re-leíble con cabeceras y filas', async () => {
  const buf = await exporters.journalWorkbookBuffer(entries);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Libro Diario');
  assert.ok(ws);
  assert.equal(ws.getRow(1).getCell(1).value, 'N°');
  assert.equal(ws.getRow(1).getCell(5).value, 'Debe');
  // 1 cabecera + 3 líneas
  assert.equal(ws.rowCount, 4);
});

test('trialBalanceWorkbookBuffer: incluye totales', async () => {
  const tb = { accounts: [{ code: '1011', name: 'Caja', debit: 100, credit: 0, balance: 100 }], totalDebit: 100, totalCredit: 100 };
  const buf = await exporters.trialBalanceWorkbookBuffer(tb);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Balance de Comprobación');
  assert.equal(ws.getRow(1).getCell(1).value, 'Cuenta');
  // cabecera + 1 cuenta + TOTALES
  assert.equal(ws.rowCount, 3);
});

test('invoicesWorkbookBuffer: cabeceras de comprobantes', async () => {
  const buf = await exporters.invoicesWorkbookBuffer([{ docType: 'FACTURA', series: 'F001', number: 1, issueDate: new Date('2026-06-15'), customerName: 'ACME', gravado: 100, igv: 18, total: 118, status: 'ISSUED' }]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Comprobantes');
  assert.equal(ws.getRow(1).getCell(1).value, 'Tipo');
  assert.equal(ws.rowCount, 2);
});

test('incomeStatementPdfBuffer: PDF válido', async () => {
  const buf = await exporters.incomeStatementPdfBuffer({ ingresos: 100, gastos: 60, utilidad: 40 });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});

test('balanceSheetPdfBuffer: PDF válido', async () => {
  const buf = await exporters.balanceSheetPdfBuffer({ activo: 118, pasivo: 18, patrimonio: 0, resultado: 100, pasivoPatrimonioYResultado: 118, balanced: true, difference: 0 });
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});
