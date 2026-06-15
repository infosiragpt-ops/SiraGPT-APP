'use strict';

/**
 * Cimientos contables — invariantes de partida doble, dinero exacto y catálogo
 * PCGE. Pure unit tests (sin DB; el seed se prueba con un Prisma fake).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const money = require('../src/services/accounting/money');
const de = require('../src/services/accounting/double-entry');
const pcge = require('../src/services/accounting/pcge');

// ── money ──────────────────────────────────────────────────────────────────
test('money: exact 2-decimal arithmetic (no float drift)', () => {
  assert.equal(money.round2(0.1 + 0.2), 0.3);
  assert.equal(money.sum2([0.1, 0.2, 0.3]), 0.6);
  assert.equal(money.round2(2.675), 2.68); // half-up
  assert.equal(money.round2(1.005), 1.01);
  assert.equal(money.toCents(1234.56), 123456);
  assert.equal(money.sum2([10.005, 20.004]), 30.01);
  assert.ok(money.eqMoney(0.1 + 0.2, 0.3));
});

test('money: tolerates strings and Decimal-like objects', () => {
  assert.equal(money.round2('19.999'), 20);
  assert.equal(money.toCents({ toString: () => '5.5' }), 550);
  assert.equal(money.round2(null), 0);
});

// ── partida doble ────────────────────────────────────────────────────────────
test('validateBalanced: a balanced entry passes', () => {
  const r = de.validateBalanced([
    { debit: 118.0, credit: 0 },
    { debit: 0, credit: 100.0 },
    { debit: 0, credit: 18.0 },
  ]);
  assert.equal(r.balanced, true);
  assert.equal(r.totalDebit, 118.0);
  assert.equal(r.totalCredit, 118.0);
  assert.equal(r.difference, 0);
  assert.deepEqual(r.errors, []);
});

test('validateBalanced: debe != haber fails with a clear error', () => {
  const r = de.validateBalanced([
    { debit: 100, credit: 0 },
    { debit: 0, credit: 90 },
  ]);
  assert.equal(r.balanced, false);
  assert.equal(r.difference, 10);
  assert.ok(r.errors.some((e) => /no es igual/.test(e)));
});

test('validateBalanced: rejects a line with both debit and credit, negatives, and empties', () => {
  assert.equal(de.validateBalanced([{ debit: 50, credit: 50 }, { debit: 0, credit: 0 }]).balanced, false);
  assert.equal(de.validateBalanced([{ debit: -10, credit: 0 }, { debit: 0, credit: -10 }]).balanced, false);
  assert.equal(de.validateBalanced([{ debit: 0, credit: 0 }, { debit: 0, credit: 0 }]).balanced, false);
});

test('validateBalanced: requires at least two lines', () => {
  assert.equal(de.validateBalanced([{ debit: 100, credit: 0 }]).balanced, false);
  assert.equal(de.validateBalanced([]).balanced, false);
});

test('validateBalanced: balances to the cent (rounding-safe)', () => {
  const r = de.validateBalanced([
    { debit: 33.33, credit: 0 },
    { debit: 33.33, credit: 0 },
    { debit: 33.34, credit: 0 },
    { debit: 0, credit: 100.0 },
  ]);
  assert.equal(r.balanced, true);
});

test('assertBalanced: throws a typed error on an unbalanced entry', () => {
  assert.throws(
    () => de.assertBalanced([{ debit: 100, credit: 0 }, { debit: 0, credit: 99 }]),
    (e) => e.code === 'UNBALANCED_ENTRY' && e.details && e.details.difference === 1,
  );
});

test('account code helpers (element / level / parent)', () => {
  assert.equal(de.accountElement('1011'), 1);
  assert.equal(de.accountElement('70'), 7);
  assert.equal(de.accountLevel('1'), 1);
  assert.equal(de.accountLevel('1011'), 4);
  assert.equal(de.parentCode('1011'), '101');
  assert.equal(de.parentCode('10'), '1');
  assert.equal(de.parentCode('1'), null);
  assert.equal(de.isValidElement(7), true);
  assert.equal(de.isValidElement(0), false);
});

// ── catálogo PCGE ────────────────────────────────────────────────────────────
test('pcge: catalog has the 9 elements + 2-digit accounts, all consistent', () => {
  const rows = pcge.pcgeAccounts();
  const elements = rows.filter((r) => r.level === 1);
  assert.equal(elements.length, 9);
  assert.deepEqual(elements.map((e) => e.code).sort(), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);

  const codes = new Set(rows.map((r) => r.code));
  for (const r of rows) {
    assert.ok(de.isValidElement(r.element), `elemento inválido en ${r.code}`);
    assert.equal(r.element, de.accountElement(r.code));
    assert.equal(r.level, de.accountLevel(r.code));
    assert.ok(['DEUDORA', 'ACREEDORA'].includes(r.nature), `naturaleza inválida en ${r.code}`);
    if (r.level >= 2) assert.ok(codes.has(r.parentCode), `falta el padre de ${r.code}`);
    // Sólo las cuentas de detalle (hoja) pueden ser postable; elementos y
    // cuentas de 2 dígitos nunca aceptan asientos.
    if (r.level <= 2) assert.equal(r.postable, false, `${r.code} no debe ser postable`);
  }
  // Tras añadir cuentas de detalle, debe haber cuentas postable (1011, 1212, 40111, 7011…).
  assert.ok(rows.some((r) => r.postable === true), 'debe existir al menos una cuenta postable');
  for (const code of ['1011', '1212', '40111', '7011']) {
    const acc = rows.find((r) => r.code === code);
    assert.ok(acc && acc.postable === true, `la cuenta de detalle ${code} debe ser postable`);
  }
});

test('pcge: contra accounts carry the correct (overridden) nature', () => {
  const byCode = Object.fromEntries(pcge.pcgeAccounts().map((r) => [r.code, r]));
  assert.equal(byCode['70'].nature, 'ACREEDORA'); // Ventas
  assert.equal(byCode['74'].nature, 'DEUDORA'); // Descuentos concedidos (contra-ingreso)
  assert.equal(byCode['19'].nature, 'ACREEDORA'); // Estimación cobranza dudosa (contra-activo)
  assert.equal(byCode['39'].nature, 'ACREEDORA'); // Depreciación acumulada (contra-activo)
  assert.equal(byCode['12'].nature, 'DEUDORA'); // CxC comerciales
  assert.equal(byCode['40'].nature, 'ACREEDORA'); // Tributos por pagar
});

test('seedPcge: idempotently upserts every account (fake prisma)', async () => {
  const upserts = [];
  const fakePrisma = {
    accountingAccount: {
      upsert: async (args) => { upserts.push(args.where.code); return args.create; },
    },
  };
  const res = await pcge.seedPcge(fakePrisma);
  assert.equal(res.count, pcge.pcgeAccounts().length);
  assert.equal(upserts.length, res.count);
  assert.ok(upserts.includes('70'));
  assert.ok(upserts.includes('1'));
});
