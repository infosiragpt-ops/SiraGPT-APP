'use strict';

/**
 * Libro Diario — alta de asientos con validación estricta de partida doble,
 * numeración correlativa, resolución de cuentas y validación zod. Sin DB real:
 * Prisma fake en memoria.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const journal = require('../src/services/accounting/journal');

function fakePrisma({ accounts = ['10', '12', '40', '70'], lastNumber = 0 } = {}) {
  const accountRows = accounts.map((code, i) => ({ id: `acc_${code}_${i}`, code, postable: true, isActive: true }));
  const created = [];
  let maxNumber = lastNumber;
  return {
    _created: created,
    accountingAccount: {
      findMany: async ({ where }) => {
        const wanted = where.code.in;
        return accountRows.filter((r) => wanted.includes(r.code) && r.isActive);
      },
    },
    accountingJournalEntry: {
      findFirst: async () => (maxNumber > 0 ? { number: maxNumber } : null),
      create: async ({ data }) => {
        maxNumber = data.number;
        const entry = { id: `je_${data.number}`, ...data, lines: data.lines.create };
        created.push(entry);
        return entry;
      },
      findMany: async () => created,
      count: async () => created.length,
      findUnique: async ({ where }) => created.find((e) => e.id === where.id) || null,
    },
  };
}

const balancedLines = [
  { accountCode: '12', debit: 118.0, credit: 0 },
  { accountCode: '70', debit: 0, credit: 100.0 },
  { accountCode: '40', debit: 0, credit: 18.0 },
];

test('createJournalEntry: balanced entry persists with number, resolved accountIds, rounded amounts', async () => {
  const prisma = fakePrisma({ lastNumber: 41 });
  const entry = await journal.createJournalEntry({
    prisma,
    input: { glosa: 'Venta con IGV', lines: balancedLines },
    userId: 'u1',
  });
  assert.equal(entry.number, 42); // correlativo = último(41) + 1
  assert.equal(entry.status, 'POSTED');
  assert.equal(entry.currency, 'PEN');
  assert.equal(entry.userId, 'u1');
  assert.equal(entry.lines.length, 3);
  // accountId resuelto desde accountCode
  assert.ok(entry.lines.every((l) => typeof l.accountId === 'string' && l.accountId.length > 0));
  assert.equal(entry.lines[0].accountCode, '12');
  assert.equal(entry.lines[0].debit, 118.0);
});

test('createJournalEntry: unbalanced entry is rejected (UNBALANCED_ENTRY)', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { glosa: 'Mal', lines: [
      { accountCode: '12', debit: 100, credit: 0 },
      { accountCode: '70', debit: 0, credit: 90 },
    ] } }),
    (e) => e.code === 'UNBALANCED_ENTRY',
  );
  assert.equal(prisma._created.length, 0); // no se persiste nada
});

test('createJournalEntry: unknown account is rejected (ACCOUNT_NOT_FOUND)', async () => {
  const prisma = fakePrisma({ accounts: ['12', '70'] }); // falta 40
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { glosa: 'IGV', lines: balancedLines } }),
    (e) => e.code === 'ACCOUNT_NOT_FOUND' && e.missing.includes('40'),
  );
});

test('createJournalEntry: zod rejects bad input (sin glosa, <2 líneas, USD sin TC)', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { lines: balancedLines } }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { glosa: 'x', lines: [{ accountCode: '12', debit: 1, credit: 0 }] } }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    () => journal.createJournalEntry({ prisma, input: { glosa: 'x', currency: 'USD', lines: balancedLines } }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => i.path === 'exchangeRate'),
  );
});

test('createJournalEntry: USD with exchange rate is accepted', async () => {
  const prisma = fakePrisma();
  const entry = await journal.createJournalEntry({
    prisma,
    input: { glosa: 'Venta USD', currency: 'USD', exchangeRate: 3.75, lines: balancedLines },
  });
  assert.equal(entry.currency, 'USD');
  assert.equal(entry.exchangeRate, 3.75);
});

test('nextEntryNumber: 1 on empty book, last+1 otherwise', async () => {
  assert.equal(await journal.nextEntryNumber(fakePrisma({ lastNumber: 0 })), 1);
  assert.equal(await journal.nextEntryNumber(fakePrisma({ lastNumber: 99 })), 100);
});

test('list + get journal entries', async () => {
  const prisma = fakePrisma();
  const e = await journal.createJournalEntry({ prisma, input: { glosa: 'A', lines: balancedLines } });
  const list = await journal.listJournalEntries({ prisma });
  assert.equal(list.total, 1);
  const got = await journal.getJournalEntry({ prisma, id: e.id });
  assert.equal(got.id, e.id);
  assert.equal(await journal.getJournalEntry({ prisma, id: 'nope' }), null);
});
