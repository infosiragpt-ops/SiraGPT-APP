'use strict';

/**
 * Periodos contables — apertura/cierre y bloqueo de asientos en periodos
 * cerrados (incl. integración con journal.createJournalEntry). fakePrisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const periods = require('../src/services/accounting/periods');
const journal = require('../src/services/accounting/journal');

function fakePeriodPrisma(initial = []) {
  const store = new Map(initial.map((p) => [`${p.year}-${p.month}`, p]));
  return {
    store,
    accountingPeriod: {
      upsert: async ({ where, update, create }) => {
        const key = `${where.year_month.year}-${where.year_month.month}`;
        const existing = store.get(key);
        const row = existing ? { ...existing, ...update } : { id: `per_${key}`, ...create };
        store.set(key, row);
        return row;
      },
      findUnique: async ({ where }) => store.get(`${where.year_month.year}-${where.year_month.month}`) || null,
      findMany: async () => [...store.values()],
    },
  };
}

test('monthBounds + yearMonthOf', () => {
  const { startDate, endDate } = periods.monthBounds(2026, 2);
  assert.equal(startDate.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(endDate.toISOString(), '2026-02-28T23:59:59.999Z');
  const ym = periods.yearMonthOf(new Date('2026-06-15T10:00:00Z'));
  assert.deepEqual(ym, { year: 2026, month: 6 });
});

test('openPeriod / closePeriod (idempotente)', async () => {
  const prisma = fakePeriodPrisma();
  const opened = await periods.openPeriod({ prisma, input: { year: 2026, month: 6 } });
  assert.equal(opened.status, 'OPEN');
  const closed = await periods.closePeriod({ prisma, input: { year: 2026, month: 6 }, closedBy: 'u1' });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closedBy, 'u1');
  assert.ok(closed.closedAt);
  const reopened = await periods.openPeriod({ prisma, input: { year: 2026, month: 6 } });
  assert.equal(reopened.status, 'OPEN');
  assert.equal(reopened.closedAt, null);
});

test('parsePeriodInput rejects invalid month', () => {
  assert.throws(() => periods.parsePeriodInput({ year: 2026, month: 13 }), (e) => e.code === 'VALIDATION_ERROR');
});

test('assertDateOpen: CLOSED period throws PERIOD_CLOSED; OPEN/absent allowed', async () => {
  const prisma = fakePeriodPrisma([
    { id: 'p1', year: 2026, month: 1, status: 'CLOSED' },
    { id: 'p2', year: 2026, month: 6, status: 'OPEN' },
  ]);
  await assert.rejects(
    () => periods.assertDateOpen({ prisma, date: new Date('2026-01-15T00:00:00Z') }),
    (e) => e.code === 'PERIOD_CLOSED' && e.period.month === 1,
  );
  const open = await periods.assertDateOpen({ prisma, date: new Date('2026-06-10T00:00:00Z') });
  assert.equal(open.status, 'OPEN');
  // mes sin periodo → permitido (null)
  assert.equal(await periods.assertDateOpen({ prisma, date: new Date('2026-09-01T00:00:00Z') }), null);
});

test('assertDateOpen: gracefully skips when the model is absent', async () => {
  assert.equal(await periods.assertDateOpen({ prisma: {}, date: new Date() }), null);
});

test('journal.createJournalEntry: blocked when the entry date is in a CLOSED period', async () => {
  const lines = [
    { accountCode: '12', debit: 100, credit: 0 },
    { accountCode: '70', debit: 0, credit: 100 },
  ];
  const prisma = {
    accountingPeriod: {
      findUnique: async () => ({ id: 'p1', year: 2026, month: 1, status: 'CLOSED' }),
    },
    accountingAccount: { findMany: async ({ where }) => where.code.in.map((c) => ({ id: `a_${c}`, code: c, postable: true })) },
    accountingJournalEntry: { findFirst: async () => null, create: async ({ data }) => ({ id: 'x', ...data }) },
  };
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { glosa: 'En periodo cerrado', date: '2026-01-15', lines } }),
    (e) => e.code === 'PERIOD_CLOSED',
  );
});

test('journal.createJournalEntry: sets periodId from the open period for the date', async () => {
  const lines = [
    { accountCode: '12', debit: 100, credit: 0 },
    { accountCode: '70', debit: 0, credit: 100 },
  ];
  let createdData = null;
  const prisma = {
    accountingPeriod: { findUnique: async () => ({ id: 'per-open', year: 2026, month: 6, status: 'OPEN' }) },
    accountingAccount: { findMany: async ({ where }) => where.code.in.map((c) => ({ id: `a_${c}`, code: c, postable: true })) },
    accountingJournalEntry: { findFirst: async () => null, create: async ({ data }) => { createdData = data; return { id: 'x', ...data }; } },
  };
  await journal.createJournalEntry({ prisma, input: { glosa: 'OK', date: '2026-06-15', lines } });
  assert.equal(createdData.periodId, 'per-open');
});
