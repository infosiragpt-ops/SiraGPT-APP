'use strict';

/**
 * Asientos automáticos por venta/cobro — mapeo balanceado, IGV en el asiento,
 * cobro, e integración con invoicing.issueInvoice. fakePrisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const autoJournal = require('../src/services/accounting/auto-journal');
const invoicing = require('../src/services/accounting/invoicing');
const { validateBalanced } = require('../src/services/accounting/double-entry');
const { createStubAdapter } = require('../src/services/accounting/ose-adapter');

const POSTABLE = ['1212', '7011', '40111', '1011', '1041'];

function fakePrisma({ invoice } = {}) {
  let inv = invoice ? { ...invoice } : null;
  const entries = [];
  let n = 0;
  return {
    entries,
    accountingInvoice: {
      findUnique: async () => (inv ? { ...inv } : null),
      update: async ({ data }) => { inv = { ...inv, ...data }; return inv; },
      create: async ({ data }) => { inv = { id: 'inv1', ...data, lines: data.lines.create }; return inv; },
      findFirst: async () => null,
    },
    accountingAccount: {
      findMany: async ({ where }) => where.code.in.filter((c) => POSTABLE.includes(c)).map((c) => ({ id: `a_${c}`, code: c, postable: true })),
    },
    accountingJournalEntry: {
      findFirst: async () => (n ? { number: n } : null),
      create: async ({ data }) => { n = data.number; const e = { id: `je_${n}`, ...data, lines: data.lines.create }; entries.push(e); return e; },
    },
  };
}

const baseInvoice = {
  id: 'inv1', docType: 'FACTURA', series: 'F001', number: 1, issueDate: new Date('2026-06-15'),
  customerName: 'ACME', currency: 'PEN', exchangeRate: null,
  gravado: 100, exonerado: 0, inafecto: 0, igv: 18, total: 118, userId: 'u1', journalEntryId: null,
};

test('invoiceToJournalLines: cargo CxC = total; abonos ventas + IGV; balanceado', () => {
  const lines = autoJournal.invoiceToJournalLines(baseInvoice);
  const byAcc = Object.fromEntries(lines.map((l) => [l.accountCode, l]));
  assert.equal(byAcc['1212'].debit, 118);
  assert.equal(byAcc['7011'].credit, 100);
  assert.equal(byAcc['40111'].credit, 18);
  assert.equal(validateBalanced(lines).balanced, true);
});

test('invoiceToJournalLines: sin IGV (exonerado) → sin línea de IGV', () => {
  const lines = autoJournal.invoiceToJournalLines({ ...baseInvoice, gravado: 0, exonerado: 200, igv: 0, total: 200 });
  assert.equal(lines.length, 2);
  assert.equal(validateBalanced(lines).balanced, true);
  assert.equal(lines.find((l) => l.accountCode === '7011').credit, 200);
});

test('postInvoiceSale: crea asiento SALE y enlaza journalEntryId (idempotente)', async () => {
  const prisma = fakePrisma({ invoice: baseInvoice });
  const r = await autoJournal.postInvoiceSale({ prisma, invoiceId: 'inv1' });
  assert.equal(r.entry.source, 'SALE');
  assert.equal(r.entry.sourceId, 'inv1');
  assert.equal(r.entry.lines.length, 3);
  assert.ok(r.journalEntryId);
  // idempotente: si ya tiene journalEntryId, no duplica
  const prisma2 = fakePrisma({ invoice: { ...baseInvoice, journalEntryId: 'je_existing' } });
  const r2 = await autoJournal.postInvoiceSale({ prisma: prisma2, invoiceId: 'inv1' });
  assert.equal(r2.skipped, true);
  assert.equal(prisma2.entries.length, 0);
});

test('registerPayment: asiento de cobro balanceado (efectivo / CxC)', async () => {
  const prisma = fakePrisma({ invoice: baseInvoice });
  const entry = await autoJournal.registerPayment({ prisma, invoiceId: 'inv1' });
  assert.equal(entry.source, 'PAYMENT');
  const byAcc = Object.fromEntries(entry.lines.map((l) => [l.accountCode, l]));
  assert.equal(byAcc['1011'].debit, 118);
  assert.equal(byAcc['1212'].credit, 118);
  assert.equal(validateBalanced(entry.lines).balanced, true);
  // cobro parcial
  const partial = await autoJournal.registerPayment({ prisma, invoiceId: 'inv1', amount: 50, account: '1041' });
  assert.equal(partial.lines.find((l) => l.accountCode === '1041').debit, 50);
});

test('issueInvoice integra el asiento de venta automáticamente', async () => {
  // prisma que soporta create de invoice + emisión + contabilización
  const accounts = POSTABLE;
  let inv = null; const entries = []; let jn = 0;
  const prisma = {
    accountingInvoice: {
      findFirst: async () => null,
      create: async ({ data }) => { inv = { id: 'inv1', ...data, lines: data.lines.create }; return inv; },
      findUnique: async () => (inv ? { ...inv } : null),
      update: async ({ data }) => { inv = { ...inv, ...data }; return inv; },
    },
    accountingAccount: { findMany: async ({ where }) => where.code.in.filter((c) => accounts.includes(c)).map((c) => ({ id: `a_${c}`, code: c, postable: true })) },
    accountingJournalEntry: { findFirst: async () => (jn ? { number: jn } : null), create: async ({ data }) => { jn = data.number; const e = { id: `je_${jn}`, ...data, lines: data.lines.create }; entries.push(e); return e; } },
  };
  const created = await invoicing.createInvoice({ prisma, input: { docType: 'FACTURA', series: 'F001', customerDoc: '20512345678', customerName: 'ACME', lines: [{ description: 'Plan', quantity: 1, unitPrice: 100, taxType: 'GRAVADO' }] } });
  const issued = await invoicing.issueInvoice({ prisma, id: created.id, adapter: createStubAdapter() });
  assert.equal(issued.status, 'ISSUED');
  assert.ok(issued.journalEntryId, 'el comprobante emitido queda enlazado a su asiento');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'SALE');
});
