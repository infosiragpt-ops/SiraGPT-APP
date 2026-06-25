'use strict';

/**
 * Facturación + comprobantes electrónicos — IGV 18% exacto, boleta vs factura,
 * numeración por serie, emisión vía adaptador OSE (stub). fakePrisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const igv = require('../src/services/accounting/igv');
const invoicing = require('../src/services/accounting/invoicing');
const { createStubAdapter, getOseAdapter } = require('../src/services/accounting/ose-adapter');

// ── IGV puro ─────────────────────────────────────────────────────────────────
test('computeLineTax: IGV 18% exacto sobre base', () => {
  const r = igv.computeLineTax({ quantity: 1, unitPrice: 100, taxType: 'GRAVADO' });
  assert.deepEqual({ base: r.base, igv: r.igv, total: r.total }, { base: 100, igv: 18, total: 118 });
});

test('computeLineTax: redondeo correcto a 2 decimales', () => {
  // 3 x 33.33 = 99.99 base; IGV = 17.9982 → 18.00; total 117.99
  const r = igv.computeLineTax({ quantity: 3, unitPrice: 33.33, taxType: 'GRAVADO' });
  assert.equal(r.base, 99.99);
  assert.equal(r.igv, 18.0);
  assert.equal(r.total, 117.99);
});

test('computeLineTax: exonerado/inafecto sin IGV', () => {
  assert.equal(igv.computeLineTax({ quantity: 2, unitPrice: 50, taxType: 'EXONERADO' }).igv, 0);
  assert.equal(igv.computeLineTax({ quantity: 2, unitPrice: 50, taxType: 'INAFECTO' }).total, 100);
});

test('computeInvoiceTotals: agrega por tipo de afectación', () => {
  const t = igv.computeInvoiceTotals([
    { quantity: 1, unitPrice: 100, taxType: 'GRAVADO' },
    { quantity: 1, unitPrice: 50, taxType: 'EXONERADO' },
    { quantity: 1, unitPrice: 20, taxType: 'INAFECTO' },
  ]);
  assert.equal(t.gravado, 100);
  assert.equal(t.exonerado, 50);
  assert.equal(t.inafecto, 20);
  assert.equal(t.igv, 18);
  assert.equal(t.total, 188); // 118 + 50 + 20
});

// ── invoicing ────────────────────────────────────────────────────────────────
function fakeInvoicePrisma({ lastBySeries = {} } = {}) {
  const invoices = [];
  const maxBySeries = { ...lastBySeries };
  return {
    invoices,
    accountingInvoice: {
      findFirst: async ({ where }) => (maxBySeries[where.series] ? { number: maxBySeries[where.series] } : null),
      create: async ({ data }) => {
        maxBySeries[data.series] = data.number;
        const inv = { id: `inv_${data.series}_${data.number}`, ...data, lines: data.lines.create };
        invoices.push(inv);
        return inv;
      },
      findUnique: async ({ where }) => invoices.find((i) => i.id === where.id) || null,
      update: async ({ where, data }) => { const i = invoices.find((x) => x.id === where.id); Object.assign(i, data); return i; },
      findMany: async () => invoices,
      count: async () => invoices.length,
    },
  };
}

const factLines = [{ description: 'Plan Pro', quantity: 1, unitPrice: 100, taxType: 'GRAVADO' }];

test('createInvoice: FACTURA con RUC calcula IGV y numera por serie', async () => {
  const prisma = fakeInvoicePrisma({ lastBySeries: { F001: 7 } });
  const inv = await invoicing.createInvoice({
    prisma,
    input: { docType: 'FACTURA', series: 'F001', customerDoc: '20512345678', customerName: 'ACME SAC', lines: factLines },
  });
  assert.equal(inv.number, 8);
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.gravado, 100);
  assert.equal(inv.igv, 18);
  assert.equal(inv.total, 118);
  assert.equal(inv.lines[0].igv, 18);
});

test('createInvoice: FACTURA sin RUC válido se rechaza', async () => {
  const prisma = fakeInvoicePrisma();
  await assert.rejects(
    () => invoicing.createInvoice({ prisma, input: { docType: 'FACTURA', series: 'F001', customerName: 'X', lines: factLines } }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => i.path === 'customerDoc'),
  );
});

test('createInvoice: BOLETA no requiere RUC', async () => {
  const prisma = fakeInvoicePrisma();
  const inv = await invoicing.createInvoice({ prisma, input: { docType: 'BOLETA', series: 'B001', customerName: 'Cliente Final', lines: factLines } });
  assert.equal(inv.docType, 'BOLETA');
  assert.equal(inv.number, 1);
  assert.equal(inv.total, 118);
});

test('issueInvoice: emite vía adaptador stub → ISSUED + CDR', async () => {
  const prisma = fakeInvoicePrisma();
  const created = await invoicing.createInvoice({ prisma, input: { docType: 'BOLETA', series: 'B001', customerName: 'X', lines: factLines } });
  const issued = await invoicing.issueInvoice({ prisma, id: created.id, adapter: createStubAdapter() });
  assert.equal(issued.status, 'ISSUED');
  assert.equal(issued.sunatStatus, 'ACCEPTED');
  assert.ok(issued.sunatTicket && issued.sunatTicket.startsWith('STUB-'));
  assert.ok(issued.cdrHash);
  // idempotente
  const again = await invoicing.issueInvoice({ prisma, id: created.id, adapter: createStubAdapter() });
  assert.equal(again.status, 'ISSUED');
});

test('getOseAdapter: default = stub; nubefact lanza OSE_NOT_CONFIGURED', async () => {
  assert.equal(getOseAdapter({}).name, 'stub');
  const nf = getOseAdapter({ OSE_PROVIDER: 'nubefact' });
  assert.equal(nf.name, 'nubefact');
  await assert.rejects(() => nf.emit({}), (e) => e.code === 'OSE_NOT_CONFIGURED');
});

test('issueInvoice: comprobante inexistente → NOT_FOUND', async () => {
  const prisma = fakeInvoicePrisma();
  await assert.rejects(() => invoicing.issueInvoice({ prisma, id: 'nope', adapter: createStubAdapter() }), (e) => e.code === 'NOT_FOUND');
});

// ── parseInvoiceInput (schema + superRefine) ──
test('parseInvoiceInput rejects a FACTURA without a valid 11-digit RUC', () => {
  assert.throws(
    () => invoicing.parseInvoiceInput({ docType: 'FACTURA', series: 'F001', customerName: 'ACME', customerDoc: '123', lines: [{ description: 'Item' }] }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => i.path === 'customerDoc'),
  );
});

test('parseInvoiceInput rejects a non-PEN currency without an exchangeRate', () => {
  assert.throws(
    () => invoicing.parseInvoiceInput({ docType: 'BOLETA', series: 'B001', customerName: 'ACME', currency: 'USD', lines: [{ description: 'Item' }] }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => i.path === 'exchangeRate'),
  );
});

test('parseInvoiceInput rejects an empty lines array', () => {
  assert.throws(
    () => invoicing.parseInvoiceInput({ docType: 'BOLETA', series: 'B001', customerName: 'ACME', lines: [] }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => /l[íi]nea/.test(i.message)),
  );
});

test('parseInvoiceInput accepts a valid BOLETA and defaults currency to PEN', () => {
  const data = invoicing.parseInvoiceInput({ docType: 'BOLETA', series: 'B001', customerName: 'ACME', lines: [{ description: 'Item', quantity: 2, unitPrice: 10 }] });
  assert.equal(data.currency, 'PEN');
  assert.equal(data.docType, 'BOLETA');
  assert.equal(data.lines.length, 1);
  assert.equal(data.lines[0].quantity, 2);
});

test('parseInvoiceInput accepts a FACTURA with a valid RUC', () => {
  const data = invoicing.parseInvoiceInput({ docType: 'FACTURA', series: 'F001', customerName: 'ACME SAC', customerDoc: '20123456789', lines: [{ description: 'Item' }] });
  assert.equal(data.customerDoc, '20123456789');
});

// ── nextInvoiceNumber (correlative per series) ──
test('nextInvoiceNumber returns 1 when the series has no invoices', async () => {
  const prisma = { accountingInvoice: { findFirst: async () => null } };
  assert.equal(await invoicing.nextInvoiceNumber(prisma, 'F001'), 1);
});

test('nextInvoiceNumber increments past the latest number in the series', async () => {
  const prisma = { accountingInvoice: { findFirst: async () => ({ number: 7 }) } };
  assert.equal(await invoicing.nextInvoiceNumber(prisma, 'F001'), 8);
});

test('nextInvoiceNumber isolates correlatives per series', async () => {
  const byNumber = { F001: 10, B001: 0 };
  const prisma = { accountingInvoice: { findFirst: async ({ where }) => {
    const n = byNumber[where.series] || 0;
    return n ? { number: n } : null;
  } } };
  assert.equal(await invoicing.nextInvoiceNumber(prisma, 'F001'), 11);
  assert.equal(await invoicing.nextInvoiceNumber(prisma, 'B001'), 1);
});
