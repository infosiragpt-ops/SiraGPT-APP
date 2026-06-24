'use strict';

const { assertBalanced } = require('./double-entry');
const { round2, sum2 } = require('./money');
const journal = require('./journal');

/**
 * Asientos contables automáticos a partir de operaciones comerciales.
 * Venta (comprobante emitido):
 *   12 Cuentas por cobrar comerciales (1212)  DEBE  = total
 *   70 Ventas (7011)                          HABER = base (gravada+exonerada+inafecta)
 *   40 IGV por pagar (40111)                  HABER = IGV
 * Cobro:
 *   10 Efectivo (1011/1041)  DEBE  = importe
 *   12 CxC (1212)            HABER = importe
 */

const DEFAULTS = { receivableAccount: '1212', igvAccount: '40111', salesAccount: '7011', cashAccount: '1011' };

/** Map a comprobante to balanced double-entry lines (sale). */
function invoiceToJournalLines(invoice, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const total = round2(invoice.total);
  const igv = round2(invoice.igv || 0);
  const net = sum2([invoice.gravado || 0, invoice.exonerado || 0, invoice.inafecto || 0]);
  const ref = `${invoice.series}-${invoice.number}`;
  const lines = [
    { accountCode: o.receivableAccount, debit: total, credit: 0, description: `Comprobante ${ref}` },
    { accountCode: o.salesAccount, debit: 0, credit: net, description: 'Ventas' },
  ];
  if (igv > 0) lines.push({ accountCode: o.igvAccount, debit: 0, credit: igv, description: 'IGV por pagar' });
  assertBalanced(lines); // garantiza Σdebe = Σhaber
  return lines;
}

function num(v) { return v == null ? undefined : Number(v.toString ? v.toString() : v); }

/** Create the SALE journal entry for an issued invoice and link it. Idempotent. */
async function postInvoiceSale({ prisma, invoiceId, opts } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const invoice = await prisma.accountingInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) { const e = new Error('Comprobante no encontrado'); e.code = 'NOT_FOUND'; throw e; }
  if (invoice.journalEntryId) return { skipped: true, journalEntryId: invoice.journalEntryId };

  const lines = invoiceToJournalLines(invoice, opts);
  const entry = await journal.createJournalEntry({
    prisma,
    input: {
      date: invoice.issueDate,
      glosa: `Venta ${invoice.docType} ${invoice.series}-${invoice.number} - ${invoice.customerName}`,
      currency: invoice.currency,
      exchangeRate: invoice.currency !== 'PEN' ? num(invoice.exchangeRate) : undefined,
      source: 'SALE',
      sourceId: invoice.id,
      lines,
    },
    userId: invoice.userId || null,
  });
  await prisma.accountingInvoice.update({ where: { id: invoiceId }, data: { journalEntryId: entry.id } });
  return { entry, journalEntryId: entry.id };
}

/** Create the PAYMENT (cobro) journal entry for an invoice. */
async function registerPayment({ prisma, invoiceId, account, amount, date } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const invoice = await prisma.accountingInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) { const e = new Error('Comprobante no encontrado'); e.code = 'NOT_FOUND'; throw e; }
  const cashAccount = account || DEFAULTS.cashAccount;
  const amt = round2(amount != null ? amount : invoice.total);
  const lines = [
    { accountCode: cashAccount, debit: amt, credit: 0, description: `Cobro ${invoice.series}-${invoice.number}` },
    { accountCode: DEFAULTS.receivableAccount, debit: 0, credit: amt, description: 'Cuentas por cobrar' },
  ];
  assertBalanced(lines);
  return journal.createJournalEntry({
    prisma,
    input: {
      date: date || new Date(),
      glosa: `Cobro ${invoice.series}-${invoice.number} - ${invoice.customerName}`,
      currency: invoice.currency,
      exchangeRate: invoice.currency !== 'PEN' ? num(invoice.exchangeRate) : undefined,
      source: 'PAYMENT',
      sourceId: invoice.id,
      lines,
    },
    userId: invoice.userId || null,
  });
}

module.exports = { DEFAULTS, invoiceToJournalLines, postInvoiceSale, registerPayment };
