'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseStatus,
  toDateFromUnix,
  toInt,
  compactLines,
  syncInvoiceFromStripe,
  listInvoicesForUser,
} = require('../src/services/invoice-sync');

function makeFakePrisma() {
  const invoices = new Map();
  const users = new Map();
  return {
    _invoices: invoices,
    _users: users,
    invoice: {
      async upsert({ where: { stripeInvoiceId }, create, update }) {
        const existing = invoices.get(stripeInvoiceId);
        if (existing) {
          const merged = { ...existing, ...update, updatedAt: new Date() };
          invoices.set(stripeInvoiceId, merged);
          return merged;
        }
        const row = { id: `inv_${invoices.size + 1}`, ...create, createdAt: new Date(), updatedAt: new Date() };
        invoices.set(stripeInvoiceId, row);
        return row;
      },
      async findMany({ where, orderBy, skip = 0, take = 20 }) {
        const all = [...invoices.values()].filter((i) => i.userId === where.userId);
        all.sort((a, b) => b.createdAt - a.createdAt);
        return all.slice(skip, skip + take);
      },
      async count({ where }) {
        return [...invoices.values()].filter((i) => i.userId === where.userId).length;
      },
    },
    user: {
      async findUnique({ where }) {
        if (where.stripeCustomerId) {
          for (const u of users.values()) {
            if (u.stripeCustomerId === where.stripeCustomerId) return u;
          }
        }
        return null;
      },
    },
  };
}

function makeStripeInvoice(overrides = {}) {
  return {
    id: 'in_test_1',
    customer: 'cus_test_1',
    subscription: 'sub_test_1',
    number: 'SIRA-001',
    status: 'paid',
    amount_due: 1999,
    amount_paid: 1999,
    amount_remaining: 0,
    subtotal: 1999,
    total: 1999,
    currency: 'USD',
    period_start: 1_716_000_000,
    period_end: 1_718_000_000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/abc',
    invoice_pdf: 'https://stripe.com/pdf/abc',
    status_transitions: { finalized_at: 1_716_000_500, paid_at: 1_716_001_000 },
    due_date: null,
    created: 1_716_000_000,
    lines: {
      data: [
        {
          id: 'il_1',
          description: 'Pro plan — monthly',
          amount: 1999,
          currency: 'USD',
          quantity: 1,
          period: { start: 1_716_000_000, end: 1_718_000_000 },
          proration: false,
          price: { id: 'price_pro', product: 'prod_pro' },
        },
      ],
    },
    ...overrides,
  };
}

test('normaliseStatus maps Stripe statuses to enum', () => {
  assert.equal(normaliseStatus('paid'), 'PAID');
  assert.equal(normaliseStatus('draft'), 'DRAFT');
  assert.equal(normaliseStatus('open'), 'OPEN');
  assert.equal(normaliseStatus('uncollectible'), 'UNCOLLECTIBLE');
  assert.equal(normaliseStatus('void'), 'VOID');
  assert.equal(normaliseStatus('unknown'), 'OPEN');
  assert.equal(normaliseStatus(null), 'OPEN');
  assert.equal(normaliseStatus(''), 'OPEN');
});

test('toDateFromUnix converts seconds to Date', () => {
  const d = toDateFromUnix(1_716_000_000);
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1_716_000_000 * 1000);
  assert.equal(toDateFromUnix(0), null);
  assert.equal(toDateFromUnix(null), null);
  assert.equal(toDateFromUnix(NaN), null);
});

test('toInt coerces and truncates', () => {
  assert.equal(toInt(1999), 1999);
  assert.equal(toInt('1999'), 1999);
  assert.equal(toInt(1.99), 1);
  assert.equal(toInt(undefined), 0);
  assert.equal(toInt(null), 0);
});

test('compactLines extracts essentials and returns null for missing data', () => {
  const lines = compactLines({ lines: { data: [{ id: 'il', description: 'X', amount: 100, currency: 'usd', quantity: 2, period: { start: 1, end: 2 }, price: { id: 'p', product: 'prd' } }] } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'X');
  assert.equal(lines[0].priceId, 'p');
  assert.equal(lines[0].productId, 'prd');
  assert.equal(compactLines({}), null);
  assert.equal(compactLines(null), null);
});

test('syncInvoiceFromStripe returns reason when prisma missing model', async () => {
  const r = await syncInvoiceFromStripe({}, makeStripeInvoice());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invoice_model_unavailable');
});

test('syncInvoiceFromStripe returns reason on invalid invoice', async () => {
  const prisma = makeFakePrisma();
  const r = await syncInvoiceFromStripe(prisma, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_invoice');
});

test('syncInvoiceFromStripe looks up user by stripeCustomerId when not passed', async () => {
  const prisma = makeFakePrisma();
  prisma._users.set('u1', { id: 'u1', stripeCustomerId: 'cus_test_1' });
  const r = await syncInvoiceFromStripe(prisma, makeStripeInvoice());
  assert.equal(r.ok, true);
  const row = prisma._invoices.get('in_test_1');
  assert.equal(row.userId, 'u1');
});

test('syncInvoiceFromStripe returns user_not_found when no customer match', async () => {
  const prisma = makeFakePrisma();
  const r = await syncInvoiceFromStripe(prisma, makeStripeInvoice({ customer: 'cus_unknown' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'user_not_found');
});

test('syncInvoiceFromStripe persists all fields correctly', async () => {
  const prisma = makeFakePrisma();
  const user = { id: 'u-7', stripeCustomerId: 'cus_test_1' };
  const result = await syncInvoiceFromStripe(prisma, makeStripeInvoice(), { user });
  assert.equal(result.ok, true);
  const row = prisma._invoices.get('in_test_1');
  assert.equal(row.userId, 'u-7');
  assert.equal(row.status, 'PAID');
  assert.equal(row.amountPaidCents, 1999);
  assert.equal(row.totalCents, 1999);
  assert.equal(row.currency, 'usd');
  assert.equal(row.number, 'SIRA-001');
  assert.ok(row.paidAt instanceof Date);
  assert.ok(row.issuedAt instanceof Date);
  assert.equal(row.hostedInvoiceUrl, 'https://invoice.stripe.com/i/abc');
  assert.equal(row.invoicePdfUrl, 'https://stripe.com/pdf/abc');
  assert.equal(row.lines.length, 1);
});

test('syncInvoiceFromStripe is idempotent (upsert)', async () => {
  const prisma = makeFakePrisma();
  const user = { id: 'u1', stripeCustomerId: 'cus_test_1' };
  await syncInvoiceFromStripe(prisma, makeStripeInvoice(), { user });
  await syncInvoiceFromStripe(prisma, makeStripeInvoice({ status: 'void', amount_paid: 0 }), { user });
  const row = prisma._invoices.get('in_test_1');
  assert.equal(row.status, 'VOID');
  assert.equal(row.amountPaidCents, 0);
  // Only one row exists despite double sync.
  assert.equal(prisma._invoices.size, 1);
});

test('syncInvoiceFromStripe sets paidAt to null for non-paid invoices', async () => {
  const prisma = makeFakePrisma();
  const user = { id: 'u1', stripeCustomerId: 'cus_test_1' };
  await syncInvoiceFromStripe(prisma, makeStripeInvoice({ status: 'open' }), { user });
  const row = prisma._invoices.get('in_test_1');
  assert.equal(row.status, 'OPEN');
  assert.equal(row.paidAt, null);
});

test('listInvoicesForUser returns paginated rows newest first', async () => {
  const prisma = makeFakePrisma();
  const user = { id: 'u1', stripeCustomerId: 'cus_test_1' };
  for (let i = 1; i <= 5; i++) {
    await syncInvoiceFromStripe(prisma, makeStripeInvoice({ id: `in_${i}`, number: `SIRA-${i}` }), { user });
    // Ensure distinct timestamps for ordering.
    await new Promise((r) => setTimeout(r, 1));
  }
  const result = await listInvoicesForUser(prisma, 'u1', { page: 1, limit: 3 });
  assert.equal(result.total, 5);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].number, 'SIRA-5');
});

test('listInvoicesForUser handles missing userId', async () => {
  const prisma = makeFakePrisma();
  const r = await listInvoicesForUser(prisma, '');
  assert.equal(r.total, 0);
  assert.equal(r.items.length, 0);
});

test('listInvoicesForUser clamps limit to 100', async () => {
  const prisma = makeFakePrisma();
  prisma._users.set('u1', { id: 'u1', stripeCustomerId: 'cus_test_1' });
  const r = await listInvoicesForUser(prisma, 'u1', { limit: 999 });
  assert.equal(r.limit, 100);
});
