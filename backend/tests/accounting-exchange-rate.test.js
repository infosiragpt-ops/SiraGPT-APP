'use strict';

/**
 * Multimoneda PEN/USD — registro/consulta de tipo de cambio y conversión exacta.
 * fakePrisma en memoria.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fx = require('../src/services/accounting/exchange-rate');

function fakeFxPrisma(initial = []) {
  const rows = initial.map((r, i) => ({ id: `r${i}`, ...r, date: fx.dayKey(r.date) }));
  return {
    rows,
    accountingExchangeRate: {
      upsert: async ({ where, update, create }) => {
        const k = where.date_currency_rateType;
        const found = rows.find((r) => +r.date === +fx.dayKey(k.date) && r.currency === k.currency && r.rateType === k.rateType);
        if (found) { Object.assign(found, update); return found; }
        const row = { id: `r${rows.length}`, ...create };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }) => {
        let cand = rows.filter((r) => r.currency === where.currency && r.rateType === where.rateType
          && +r.date <= +where.date.lte);
        cand.sort((a, b) => (orderBy.date === 'desc' ? +b.date - +a.date : +a.date - +b.date));
        return cand[0] || null;
      },
      findMany: async ({ where }) => rows.filter((r) => !where.currency || r.currency === where.currency),
    },
  };
}

test('convertWithRate: exact PEN<->USD', () => {
  assert.equal(fx.convertWithRate(100, 3.75, true), 375.0); // USD→PEN
  assert.equal(fx.convertWithRate(375, 3.75, false), 100.0); // PEN→USD
  assert.equal(fx.convertWithRate(33.33, 3.5, true), 116.66); // redondeo exacto
});

test('convertWithRate: rejects invalid rate', () => {
  assert.throws(() => fx.convertWithRate(100, 0, true), (e) => e.code === 'INVALID_RATE');
  assert.throws(() => fx.convertWithRate(100, -1, true), (e) => e.code === 'INVALID_RATE');
});

test('recordRate: validates + upserts (normaliza currency a mayúsculas)', async () => {
  const prisma = fakeFxPrisma();
  const r = await fx.recordRate({ prisma, input: { date: '2026-06-15', currency: 'usd', rate: 3.751 } });
  assert.equal(r.currency, 'USD');
  assert.equal(r.rateType, 'VENTA');
  assert.equal(Number(r.rate), 3.751); // stored at 6-decimal rate precision, not money round2
  // A 4-decimal SBS/SUNAT rate must survive (round2 would have corrupted it to 3.72).
  const r2 = await fx.recordRate({ prisma, input: { date: '2026-06-16', currency: 'USD', rate: 3.7234 } });
  assert.equal(Number(r2.rate), 3.7234);
  await assert.rejects(() => fx.recordRate({ prisma, input: { currency: 'US', rate: 3.7 } }), (e) => e.code === 'VALIDATION_ERROR');
  await assert.rejects(() => fx.recordRate({ prisma, input: { currency: 'USD', rate: -1 } }), (e) => e.code === 'VALIDATION_ERROR');
});

test('getRate: exact-day match, else most recent on-or-before', async () => {
  const prisma = fakeFxPrisma([
    { date: '2026-06-10', currency: 'USD', rate: 3.70, rateType: 'VENTA' },
    { date: '2026-06-14', currency: 'USD', rate: 3.75, rateType: 'VENTA' },
  ]);
  assert.equal(await fx.getRate({ prisma, currency: 'USD', date: '2026-06-14' }), 3.75); // exacto
  assert.equal(await fx.getRate({ prisma, currency: 'USD', date: '2026-06-20' }), 3.75); // más reciente <=
  assert.equal(await fx.getRate({ prisma, currency: 'USD', date: '2026-06-12' }), 3.70); // anterior
  assert.equal(await fx.getRate({ prisma, currency: 'USD', date: '2026-06-01' }), null); // ninguno
});

test('convertAmount: uses stored rate; throws RATE_NOT_FOUND when missing', async () => {
  const prisma = fakeFxPrisma([{ date: '2026-06-14', currency: 'USD', rate: 3.75, rateType: 'VENTA' }]);
  const { amount, rate } = await fx.convertAmount({ prisma, amount: 100, currency: 'USD', date: '2026-06-15', toPen: true });
  assert.equal(rate, 3.75);
  assert.equal(amount, 375.0);
  await assert.rejects(
    () => fx.convertAmount({ prisma, amount: 100, currency: 'EUR', date: '2026-06-15' }),
    (e) => e.code === 'RATE_NOT_FOUND',
  );
});

test('listRates filtra por moneda', async () => {
  const prisma = fakeFxPrisma([
    { date: '2026-06-14', currency: 'USD', rate: 3.75, rateType: 'VENTA' },
    { date: '2026-06-14', currency: 'EUR', rate: 4.10, rateType: 'VENTA' },
  ]);
  assert.equal((await fx.listRates({ prisma })).length, 2);
  assert.equal((await fx.listRates({ prisma, currency: 'usd' })).length, 1);
});
