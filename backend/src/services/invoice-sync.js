'use strict';

const { randomUUID } = require('node:crypto');

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

// Static SQL with bound values. The conflict predicate is evaluated while
// PostgreSQL owns the conflicting invoice row lock, so a delayed/open webhook
// can never overwrite a concurrently committed PAID snapshot.
const ATOMIC_INVOICE_UPSERT_SQL = `
  INSERT INTO "invoices" (
    "id",
    "userId",
    "stripeInvoiceId",
    "stripeCustomerId",
    "stripeSubscriptionId",
    "number",
    "status",
    "amountDueCents",
    "amountPaidCents",
    "amountRemainingCents",
    "subtotalCents",
    "totalCents",
    "currency",
    "periodStart",
    "periodEnd",
    "hostedInvoiceUrl",
    "invoicePdfUrl",
    "lines",
    "issuedAt",
    "paidAt",
    "dueDate",
    "updatedAt"
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7::"InvoiceStatus",
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15,
    $16,
    $17,
    $18::jsonb,
    $19,
    $20,
    $21,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("stripeInvoiceId") DO UPDATE SET
    "userId" = EXCLUDED."userId",
    "stripeCustomerId" = EXCLUDED."stripeCustomerId",
    "stripeSubscriptionId" = EXCLUDED."stripeSubscriptionId",
    "number" = EXCLUDED."number",
    "status" = EXCLUDED."status",
    "amountDueCents" = EXCLUDED."amountDueCents",
    "amountPaidCents" = EXCLUDED."amountPaidCents",
    "amountRemainingCents" = EXCLUDED."amountRemainingCents",
    "subtotalCents" = EXCLUDED."subtotalCents",
    "totalCents" = EXCLUDED."totalCents",
    "currency" = EXCLUDED."currency",
    "periodStart" = EXCLUDED."periodStart",
    "periodEnd" = EXCLUDED."periodEnd",
    "hostedInvoiceUrl" = EXCLUDED."hostedInvoiceUrl",
    "invoicePdfUrl" = EXCLUDED."invoicePdfUrl",
    "lines" = COALESCE(EXCLUDED."lines", "invoices"."lines"),
    "issuedAt" = EXCLUDED."issuedAt",
    "paidAt" = EXCLUDED."paidAt",
    "dueDate" = EXCLUDED."dueDate",
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE NOT (
    "invoices"."status" = 'PAID'::"InvoiceStatus"
    AND EXCLUDED."status" <> 'PAID'::"InvoiceStatus"
  )
  RETURNING "id", "status"
`;

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

function stripeResourceId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

/**
 * Stripe's 2025+ invoice shape moved the subscription reference under
 * `parent.subscription_details.subscription`. Keep the top-level field as a
 * fallback for webhook fixtures and older Stripe API versions.
 */
function stripeInvoiceSubscriptionId(invoice) {
  return stripeResourceId(invoice?.parent?.subscription_details?.subscription)
    || stripeResourceId(invoice?.subscription);
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
 * @returns {Promise<{
 *   ok: boolean,
 *   invoiceId?: string,
 *   authoritativeStatus?: string,
 *   skipped?: boolean,
 *   reason?: string
 * }>}
 */
async function syncInvoiceFromStripe(prisma, invoice, opts = {}) {
  if (!prisma?.invoice || typeof prisma.$queryRawUnsafe !== 'function') {
    return { ok: false, reason: 'invoice_model_unavailable' };
  }
  if (!invoice || !invoice.id) {
    return { ok: false, reason: 'invalid_invoice' };
  }
  const customerId = stripeResourceId(invoice.customer);
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
    stripeSubscriptionId: stripeInvoiceSubscriptionId(invoice),
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

  const rows = await prisma.$queryRawUnsafe(
    ATOMIC_INVOICE_UPSERT_SQL,
    randomUUID(),
    data.userId,
    data.stripeInvoiceId,
    data.stripeCustomerId,
    data.stripeSubscriptionId,
    data.number,
    data.status,
    data.amountDueCents,
    data.amountPaidCents,
    data.amountRemainingCents,
    data.subtotalCents,
    data.totalCents,
    data.currency,
    data.periodStart,
    data.periodEnd,
    data.hostedInvoiceUrl,
    data.invoicePdfUrl,
    lines ? JSON.stringify(lines) : null,
    data.issuedAt,
    data.paidAt,
    data.dueDate,
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return {
      ok: true,
      skipped: true,
      reason: 'invoice_status_regression',
      authoritativeStatus: 'PAID',
    };
  }
  return {
    ok: true,
    invoiceId: row.id,
    authoritativeStatus: row.status,
  };
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.invoice.count({ where: { userId } }),
  ]);
  return { items, total, page, limit };
}

module.exports = {
  ATOMIC_INVOICE_UPSERT_SQL,
  STATUS_MAP,
  normaliseStatus,
  toDateFromUnix,
  toInt,
  compactLines,
  stripeInvoiceSubscriptionId,
  syncInvoiceFromStripe,
  listInvoicesForUser,
};
