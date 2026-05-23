'use strict';

/**
 * invoice-sync — keep the local `invoices` table consistent with Stripe.
 *
 * Spec §8: the billing UI must show invoices, recent purchases, and
 * receipts. Reading them from Stripe on every page load is slow and
 * brittle (Stripe outage → no invoice list at all). This module upserts
 * a local copy from webhook events so the UI reads from Postgres.
 *
 * The webhook handlers in routes/payments.js call `syncInvoiceFromStripe`
 * for invoice.* events. Idempotent by stripeInvoiceId — replaying a
 * webhook just refreshes the local row.
 */

const STATUS_MAP = Object.freeze({
  draft: 'DRAFT',
  open: 'OPEN',
  paid: 'PAID',
  uncollectible: 'UNCOLLECTIBLE',
  void: 'VOID',
});

function normaliseStatus(raw) {
  if (!raw) return 'OPEN';
  const key = String(raw).toLowerCase();
  return STATUS_MAP[key] || 'OPEN';
}

function toDateFromUnix(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function toInt(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.trunc(Number(value));
}

/**
 * Extract a minimal lines array we want to persist. Stripe `lines.data`
 * is verbose; we keep just what the UI needs to render a receipt.
 */
function compactLines(invoice) {
  const arr = invoice?.lines?.data;
  if (!Array.isArray(arr)) return null;
  return arr.map((line) => ({
    id: line.id,
    description: line.description || null,
    amount: line.amount,
    currency: line.currency,
    quantity: line.quantity || 1,
    period: line.period
      ? {
          start: toDateFromUnix(line.period.start),
          end: toDateFromUnix(line.period.end),
        }
      : null,
    proration: !!line.proration,
    priceId: line.price?.id || null,
    productId: line.price?.product || null,
  }));
}

/**
 * Upsert an invoice row from a Stripe invoice object.
 *
 * @param {object} prisma   — Prisma client with `invoice` and `user` models
 * @param {object} invoice  — Stripe invoice (raw webhook payload)
 * @param {object} [opts]
 * @param {object} [opts.user] — Pre-fetched user (skips the customer lookup)
 * @returns {Promise<{ok: boolean, invoiceId?: string, reason?: string}>}
 */
async function syncInvoiceFromStripe(prisma, invoice, opts = {}) {
  if (!prisma?.invoice?.upsert) {
    return { ok: false, reason: 'invoice_model_unavailable' };
  }
  if (!invoice || !invoice.id) {
    return { ok: false, reason: 'invalid_invoice' };
  }
  const customerId = invoice.customer;
  let user = opts.user;
  if (!user) {
    if (!customerId) return { ok: false, reason: 'no_customer' };
    user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
    if (!user) return { ok: false, reason: 'user_not_found' };
  }

  const status = normaliseStatus(invoice.status);
  const isPaid = status === 'PAID';
  const lines = compactLines(invoice);

  const data = {
    userId: user.id,
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId || null,
    stripeSubscriptionId: invoice.subscription || null,
    number: invoice.number || null,
    status,
    amountDueCents: toInt(invoice.amount_due),
    amountPaidCents: toInt(invoice.amount_paid),
    amountRemainingCents: toInt(invoice.amount_remaining),
    subtotalCents: toInt(invoice.subtotal),
    totalCents: toInt(invoice.total),
    currency: (invoice.currency || 'usd').toLowerCase(),
    periodStart: toDateFromUnix(invoice.period_start),
    periodEnd: toDateFromUnix(invoice.period_end),
    hostedInvoiceUrl: invoice.hosted_invoice_url || null,
    invoicePdfUrl: invoice.invoice_pdf || null,
    lines: lines || undefined,
    issuedAt: toDateFromUnix(invoice.status_transitions?.finalized_at) || toDateFromUnix(invoice.created),
    paidAt: isPaid
      ? toDateFromUnix(invoice.status_transitions?.paid_at) || toDateFromUnix(invoice.created)
      : null,
    dueDate: toDateFromUnix(invoice.due_date),
  };

  const row = await prisma.invoice.upsert({
    where: { stripeInvoiceId: invoice.id },
    create: data,
    update: data,
  });
  return { ok: true, invoiceId: row.id };
}

/**
 * Listing helper used by the billing UI. Returns paginated invoices for
 * a user, newest first.
 */
async function listInvoicesForUser(prisma, userId, opts = {}) {
  if (!userId) return { items: [], total: 0 };
  const page = Math.max(1, Math.trunc(Number(opts.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(opts.limit) || 20)));
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.invoice.count({ where: { userId } }),
  ]);
  return { items, total, page, limit };
}

module.exports = {
  STATUS_MAP,
  normaliseStatus,
  toDateFromUnix,
  toInt,
  compactLines,
  syncInvoiceFromStripe,
  listInvoicesForUser,
};
