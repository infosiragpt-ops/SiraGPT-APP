'use strict';

const { z } = require('zod');
const { computeInvoiceTotals } = require('./igv');
const { round2, round6 } = require('./money');
const { getOseAdapter } = require('./ose-adapter');
const { withCorrelativeRetry } = require('./correlative');

const invoiceLineSchema = z.object({
  productId: z.string().trim().max(64).optional(),
  code: z.string().trim().max(40).optional(),
  description: z.string().trim().min(1, 'description requerida').max(500),
  quantity: z.coerce.number().positive().default(1),
  unitPrice: z.coerce.number().nonnegative().default(0),
  unit: z.string().trim().max(10).default('NIU'),
  taxType: z.enum(['GRAVADO', 'EXONERADO', 'INAFECTO']).default('GRAVADO'),
});

const invoiceInputSchema = z.object({
  docType: z.enum(['BOLETA', 'FACTURA']),
  series: z.string().trim().min(1).max(8),
  issueDate: z.coerce.date().default(() => new Date()),
  customerId: z.string().trim().max(64).optional(),
  customerDoc: z.string().trim().max(15).optional(),
  customerName: z.string().trim().min(1, 'customerName requerido').max(200),
  currency: z.enum(['PEN', 'USD']).default('PEN'),
  exchangeRate: z.coerce.number().positive().optional(),
  lines: z.array(invoiceLineSchema).min(1, 'El comprobante requiere al menos 1 línea'),
}).superRefine((v, ctx) => {
  if (v.docType === 'FACTURA' && !(v.customerDoc && /^(10|15|16|17|20)\d{9}$/.test(v.customerDoc))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customerDoc'], message: 'FACTURA requiere RUC válido (11 dígitos) del cliente' });
  }
  if (v.currency !== 'PEN' && !v.exchangeRate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exchangeRate'], message: 'exchangeRate requerido cuando currency != PEN' });
  }
  // Reject the PLE delimiter (|) and line breaks in fields written verbatim
  // into the pipe-delimited, CRLF-line-delimited PLE register (ple.js). A
  // customerName like "ACME|Corp" would shift every downstream field and make
  // the SUNAT export invalid.
  const PLE_FORBIDDEN = /[|\r\n]/;
  for (const field of ['customerName', 'series', 'customerDoc']) {
    if (v[field] != null && PLE_FORBIDDEN.test(String(v[field]))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} no puede contener '|' ni saltos de línea (formato PLE)`,
      });
    }
  }
});

function parseInvoiceInput(input) {
  const r = invoiceInputSchema.safeParse(input);
  if (!r.success) {
    const err = new Error('Comprobante inválido');
    err.code = 'VALIDATION_ERROR';
    err.issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw err;
  }
  return r.data;
}

/** Next correlative for a series. */
async function nextInvoiceNumber(prisma, series) {
  const last = await prisma.accountingInvoice.findFirst({ where: { series }, orderBy: { number: 'desc' }, select: { number: true } });
  return (last && last.number ? last.number : 0) + 1;
}

/**
 * Create a DRAFT invoice with IGV computed per line. Does NOT emit to SUNAT
 * (use issueInvoice for that).
 */
async function createInvoice({ prisma, input, userId = null } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const data = parseInvoiceInput(input);
  const totals = computeInvoiceTotals(data.lines);

  const lines = totals.lines.map((l) => ({
    productId: l.productId || null,
    code: l.code || null,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    unit: l.unit || 'NIU',
    taxType: l.taxType,
    base: l.base,
    igv: l.igv,
    total: l.total,
  }));

  // Correlative numbering is read-then-write; the (series, number) unique
  // constraint guards integrity but a concurrent create would fail the loser
  // with P2002. Recompute the next number and retry on conflict.
  return withCorrelativeRetry(async () => {
    const number = await nextInvoiceNumber(prisma, data.series);
    return prisma.accountingInvoice.create({
      data: {
        docType: data.docType,
        series: data.series,
        number,
        issueDate: data.issueDate,
        customerId: data.customerId || null,
        customerDoc: data.customerDoc || null,
        customerName: data.customerName,
        currency: data.currency,
        exchangeRate: data.exchangeRate != null ? round6(data.exchangeRate) : null,
        gravado: totals.gravado,
        exonerado: totals.exonerado,
        inafecto: totals.inafecto,
        igv: totals.igv,
        total: totals.total,
        status: 'DRAFT',
        userId,
        lines: { create: lines },
      },
      include: { lines: true },
    });
  });
}

/**
 * Emit a DRAFT invoice to SUNAT through the configured OSE/PSE adapter.
 * On success the invoice transitions to ISSUED with the SUNAT ticket/CDR.
 */
async function issueInvoice({ prisma, id, adapter } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const invoice = await prisma.accountingInvoice.findUnique({ where: { id }, include: { lines: true } });
  if (!invoice) { const e = new Error('Comprobante no encontrado'); e.code = 'NOT_FOUND'; throw e; }
  if (invoice.status === 'ISSUED') return invoice; // idempotente
  if (invoice.status === 'VOID') { const e = new Error('No se puede emitir un comprobante anulado'); e.code = 'INVALID_STATE'; throw e; }

  const ose = adapter || getOseAdapter();
  const result = await ose.emit(invoice);

  const updated = await prisma.accountingInvoice.update({
    where: { id },
    data: {
      status: 'ISSUED',
      sunatStatus: result.sunatStatus || 'ACCEPTED',
      sunatTicket: result.ticket || null,
      cdrHash: result.cdrHash || null,
      oseProvider: result.provider || ose.name || null,
    },
    include: { lines: true },
  });

  // Contabilización automática de la venta (tolerante: nunca rompe la emisión).
  try {
    const autoJournal = require('./auto-journal');
    const posted = await autoJournal.postInvoiceSale({ prisma, invoiceId: id });
    if (posted && posted.journalEntryId) updated.journalEntryId = posted.journalEntryId;
  } catch (postErr) {
    console.warn('[invoicing] no se pudo contabilizar la venta automáticamente:', postErr && postErr.message);
  }

  return updated;
}

async function listInvoices({ prisma, docType, status, customerId, skip = 0, take = 50 } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const where = {};
  if (docType) where.docType = docType;
  if (status) where.status = status;
  if (customerId) where.customerId = customerId;
  const [items, total] = await Promise.all([
    prisma.accountingInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { lines: true } }),
    prisma.accountingInvoice.count({ where }),
  ]);
  return { items, total, skip, take };
}

async function getInvoice({ prisma, id } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  return prisma.accountingInvoice.findUnique({ where: { id }, include: { lines: true } });
}

module.exports = {
  invoiceLineSchema,
  invoiceInputSchema,
  parseInvoiceInput,
  nextInvoiceNumber,
  createInvoice,
  issueInvoice,
  listInvoices,
  getInvoice,
};
