'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { round2 } = require('./money');

/**
 * Exportadores Excel (exceljs) y PDF (pdfkit) para el módulo contable.
 * Devuelven Buffers listos para descargar.
 */

function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}
function num(v) {
  return round2(v == null ? 0 : Number(v.toString ? v.toString() : v));
}

// ── Excel ────────────────────────────────────────────────────────────────────
async function journalWorkbookBuffer(entries) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Libro Diario');
  ws.columns = [
    { header: 'N°', key: 'number', width: 8 },
    { header: 'Fecha', key: 'date', width: 12 },
    { header: 'Glosa', key: 'glosa', width: 40 },
    { header: 'Cuenta', key: 'account', width: 12 },
    { header: 'Debe', key: 'debit', width: 14 },
    { header: 'Haber', key: 'credit', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const e of Array.isArray(entries) ? entries : []) {
    for (const l of e.lines || []) {
      ws.addRow({ number: e.number, date: fmtDate(e.date), glosa: e.glosa, account: l.accountCode, debit: num(l.debit), credit: num(l.credit) });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function trialBalanceWorkbookBuffer(trialBalance) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Balance de Comprobación');
  ws.columns = [
    { header: 'Cuenta', key: 'code', width: 12 },
    { header: 'Nombre', key: 'name', width: 40 },
    { header: 'Debe', key: 'debit', width: 14 },
    { header: 'Haber', key: 'credit', width: 14 },
    { header: 'Saldo', key: 'balance', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const a of (trialBalance && trialBalance.accounts) || []) {
    ws.addRow({ code: a.code, name: a.name || '', debit: num(a.debit), credit: num(a.credit), balance: num(a.balance) });
  }
  const totalRow = ws.addRow({ code: '', name: 'TOTALES', debit: num(trialBalance && trialBalance.totalDebit), credit: num(trialBalance && trialBalance.totalCredit), balance: '' });
  totalRow.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function invoicesWorkbookBuffer(invoices) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Comprobantes');
  ws.columns = [
    { header: 'Tipo', key: 'docType', width: 10 },
    { header: 'Serie', key: 'series', width: 8 },
    { header: 'Número', key: 'number', width: 10 },
    { header: 'Fecha', key: 'date', width: 12 },
    { header: 'Cliente', key: 'customer', width: 30 },
    { header: 'Gravado', key: 'gravado', width: 14 },
    { header: 'IGV', key: 'igv', width: 12 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Estado', key: 'status', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    ws.addRow({ docType: inv.docType, series: inv.series, number: inv.number, date: fmtDate(inv.issueDate), customer: inv.customerName, gravado: num(inv.gravado), igv: num(inv.igv), total: num(inv.total), status: inv.status });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PDF ──────────────────────────────────────────────────────────────────────
function pdfBuffer(render) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { render(doc); doc.end(); } catch (e) { reject(e); }
  });
}

function moneyLine(doc, label, value) {
  doc.fontSize(11).text(`${label}: S/ ${num(value).toFixed(2)}`);
}

function incomeStatementPdfBuffer(data, { title = 'Estado de Resultados' } = {}) {
  return pdfBuffer((doc) => {
    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();
    moneyLine(doc, 'Ingresos', data.ingresos);
    moneyLine(doc, 'Gastos', data.gastos);
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Utilidad / (Pérdida): S/ ${num(data.utilidad).toFixed(2)}`, { underline: true });
  });
}

function balanceSheetPdfBuffer(data, { title = 'Balance General' } = {}) {
  return pdfBuffer((doc) => {
    doc.fontSize(16).text(title, { align: 'center' });
    doc.moveDown();
    moneyLine(doc, 'Activo', data.activo);
    moneyLine(doc, 'Pasivo', data.pasivo);
    moneyLine(doc, 'Patrimonio', data.patrimonio);
    moneyLine(doc, 'Resultado del ejercicio', data.resultado);
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Pasivo + Patrimonio + Resultado: S/ ${num(data.pasivoPatrimonioYResultado).toFixed(2)}`);
    doc.fontSize(10).fillColor(data.balanced ? 'green' : 'red').text(data.balanced ? 'Balance cuadrado ✓' : `Descuadre: ${num(data.difference).toFixed(2)}`);
  });
}

module.exports = {
  journalWorkbookBuffer,
  trialBalanceWorkbookBuffer,
  invoicesWorkbookBuffer,
  incomeStatementPdfBuffer,
  balanceSheetPdfBuffer,
};
