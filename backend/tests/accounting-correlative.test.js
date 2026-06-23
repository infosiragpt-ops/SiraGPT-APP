'use strict';

/**
 * accounting/correlative — transparent retry for correlative numbering.
 * Covers the pure helper plus the createInvoice / createJournalEntry wiring:
 * a concurrent writer that grabs the computed number first makes the loser's
 * INSERT fail with Prisma P2002; the create must recompute the next number and
 * succeed rather than surfacing the conflict.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withCorrelativeRetry, isUniqueViolation, DEFAULT_MAX_RETRIES } = require('../src/services/accounting/correlative');
const invoicing = require('../src/services/accounting/invoicing');
const journal = require('../src/services/accounting/journal');

function p2002() {
  const e = new Error('Unique constraint failed on the fields: (`number`)');
  e.code = 'P2002';
  return e;
}

// ── pure helper ──────────────────────────────────────────────────────────────
test('withCorrelativeRetry: returns the first success without retrying', async () => {
  let calls = 0;
  const out = await withCorrelativeRetry(async () => { calls += 1; return 'ok'; });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('withCorrelativeRetry: retries on P2002 then succeeds', async () => {
  let calls = 0;
  const out = await withCorrelativeRetry(async (attempt) => {
    calls += 1;
    if (attempt < 2) throw p2002();
    return `done@${attempt}`;
  });
  assert.equal(out, 'done@2');
  assert.equal(calls, 3);
});

test('withCorrelativeRetry: rethrows P2002 once retries are exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    () => withCorrelativeRetry(() => { calls += 1; throw p2002(); }, { attempts: 2 }),
    (e) => e.code === 'P2002',
  );
  assert.equal(calls, 3); // attempts 0,1,2 then give up
});

test('withCorrelativeRetry: non-P2002 errors propagate immediately (no retry)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withCorrelativeRetry(() => { calls += 1; const e = new Error('boom'); e.code = 'P2003'; throw e; }),
    /boom/,
  );
  assert.equal(calls, 1);
});

test('isUniqueViolation + DEFAULT_MAX_RETRIES', () => {
  assert.equal(isUniqueViolation({ code: 'P2002' }), true);
  assert.equal(isUniqueViolation({ code: 'P2025' }), false);
  assert.equal(isUniqueViolation(null), false);
  assert.ok(DEFAULT_MAX_RETRIES >= 1);
});

// ── createInvoice integration ────────────────────────────────────────────────
function fakeInvoicePrismaConflictOnce() {
  let max = 0;
  let calls = 0;
  return {
    _calls: () => calls,
    accountingInvoice: {
      findFirst: async () => (max ? { number: max } : null),
      create: async ({ data }) => {
        calls += 1;
        if (calls === 1) {
          // A concurrent writer committed this number first.
          max = data.number;
          throw p2002();
        }
        max = data.number;
        return { id: `inv_${data.series}_${data.number}`, ...data, lines: data.lines.create };
      },
    },
  };
}

const factLines = [{ description: 'Plan Pro', quantity: 1, unitPrice: 100, taxType: 'GRAVADO' }];

test('createInvoice: transparently re-numbers on a unique-constraint conflict', async () => {
  const prisma = fakeInvoicePrismaConflictOnce();
  const inv = await invoicing.createInvoice({
    prisma,
    input: { docType: 'BOLETA', series: 'B001', customerName: 'Cliente Final', lines: factLines },
  });
  // First attempt grabbed number 1 and lost; retry takes number 2.
  assert.equal(inv.number, 2);
  assert.equal(prisma._calls(), 2);
});

// ── createJournalEntry integration ───────────────────────────────────────────
function fakeJournalPrismaConflictOnce() {
  let max = 0;
  let calls = 0;
  return {
    _calls: () => calls,
    accountingAccount: {
      findMany: async ({ where }) => where.code.in.map((code, i) => ({ id: `acc_${i}`, code, postable: true })),
    },
    // No `accountingPeriod` → assertDateOpen short-circuits to null (period
    // gating is out of scope for the numbering-retry test).
    accountingJournalEntry: {
      findFirst: async () => (max ? { number: max } : null),
      create: async ({ data }) => {
        calls += 1;
        if (calls === 1) {
          max = data.number;
          throw p2002();
        }
        max = data.number;
        return { id: `je_${data.number}`, ...data, lines: data.lines.create };
      },
    },
  };
}

test('createJournalEntry: transparently re-numbers on a unique-constraint conflict', async () => {
  const prisma = fakeJournalPrismaConflictOnce();
  const entry = await journal.createJournalEntry({
    prisma,
    input: {
      glosa: 'Asiento de prueba',
      lines: [
        { accountCode: '101', debit: 100, credit: 0 },
        { accountCode: '701', debit: 0, credit: 100 },
      ],
    },
  });
  assert.equal(entry.number, 2);
  assert.equal(prisma._calls(), 2);
});
