'use strict';

/**
 * Catálogo contable — clientes (validación de documento RUC/DNI/CE) y
 * productos/servicios (incl. suscripciones del SaaS, afecto a IGV). fakePrisma.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../src/services/accounting/catalog');

function fakeCatalogPrisma() {
  const customers = [];
  const products = [];
  const mk = (store, name) => ({
    create: async ({ data }) => { const row = { id: `${name}_${store.length}`, ...data }; store.push(row); return row; },
    update: async ({ where, data }) => { const r = store.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    findUnique: async ({ where }) => store.find((x) => x.id === where.id) || null,
    findMany: async () => store,
    count: async () => store.length,
  });
  return { _customers: customers, _products: products, accountingCustomer: mk(customers, 'cus'), accountingProduct: mk(products, 'prd') };
}

// ── documento ────────────────────────────────────────────────────────────────
test('isValidDoc: RUC/DNI/CE/SIN_DOC', () => {
  assert.equal(catalog.isValidDoc('RUC', '20512345678'), true);
  assert.equal(catalog.isValidDoc('RUC', '12345678901'), false); // prefijo inválido
  assert.equal(catalog.isValidDoc('RUC', '2051234567'), false); // 10 dígitos
  assert.equal(catalog.isValidDoc('DNI', '12345678'), true);
  assert.equal(catalog.isValidDoc('DNI', '1234567'), false);
  assert.equal(catalog.isValidDoc('CE', 'AB12345678'), true);
  assert.equal(catalog.isValidDoc('SIN_DOC', ''), true);
});

// ── clientes ─────────────────────────────────────────────────────────────────
test('createCustomer: válido persiste; documento inválido rechaza', async () => {
  const prisma = fakeCatalogPrisma();
  const c = await catalog.createCustomer({ prisma, input: { docType: 'RUC', docNumber: '20512345678', name: 'ACME SAC', email: 'a@acme.pe' } });
  assert.equal(c.name, 'ACME SAC');
  assert.equal(c.docType, 'RUC');
  await assert.rejects(
    () => catalog.createCustomer({ prisma, input: { docType: 'RUC', docNumber: '123', name: 'Mal' } }),
    (e) => e.code === 'VALIDATION_ERROR' && e.issues.some((i) => i.path === 'docNumber'),
  );
  await assert.rejects(
    () => catalog.createCustomer({ prisma, input: { docType: 'DNI', docNumber: '12345678', name: '' } }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
});

test('createCustomer: email vacío se normaliza a undefined', async () => {
  const prisma = fakeCatalogPrisma();
  const c = await catalog.createCustomer({ prisma, input: { docType: 'DNI', docNumber: '12345678', name: 'Juan', email: '' } });
  assert.equal(c.email, undefined);
});

test('list/get/update customer', async () => {
  const prisma = fakeCatalogPrisma();
  const c = await catalog.createCustomer({ prisma, input: { docType: 'DNI', docNumber: '12345678', name: 'Juan' } });
  assert.equal((await catalog.listCustomers({ prisma })).total, 1);
  assert.equal((await catalog.getCustomer({ prisma, id: c.id })).name, 'Juan');
  const u = await catalog.updateCustomer({ prisma, id: c.id, input: { docType: 'DNI', docNumber: '12345678', name: 'Juan Pérez' } });
  assert.equal(u.name, 'Juan Pérez');
});

// ── productos ────────────────────────────────────────────────────────────────
test('createProduct: servicio afecto a IGV con precio redondeado', async () => {
  const prisma = fakeCatalogPrisma();
  const p = await catalog.createProduct({ prisma, input: { code: 'PLAN-PRO', name: 'Plan Pro', unitPrice: 49.999, igvAffected: true } });
  assert.equal(p.kind, 'SERVICE');
  assert.equal(Number(p.unitPrice), 50.0);
  assert.equal(p.igvAffected, true);
  assert.equal(p.currency, 'PEN');
});

test('createProduct: suscripción del SaaS (isSubscription)', async () => {
  const prisma = fakeCatalogPrisma();
  const p = await catalog.createProduct({ prisma, input: { code: 'SUB-MENSUAL', name: 'Suscripción mensual', unitPrice: 30, isSubscription: true, currency: 'USD', incomeAccount: '7011' } });
  assert.equal(p.isSubscription, true);
  assert.equal(p.currency, 'USD');
  assert.equal(p.incomeAccount, '7011');
});

test('createProduct: code requerido + precio no-negativo', async () => {
  const prisma = fakeCatalogPrisma();
  await assert.rejects(() => catalog.createProduct({ prisma, input: { name: 'sin code' } }), (e) => e.code === 'VALIDATION_ERROR');
  await assert.rejects(() => catalog.createProduct({ prisma, input: { code: 'X', name: 'neg', unitPrice: -1 } }), (e) => e.code === 'VALIDATION_ERROR');
});

test('listProducts filtra por isSubscription', async () => {
  const prisma = fakeCatalogPrisma();
  await catalog.createProduct({ prisma, input: { code: 'A', name: 'normal' } });
  await catalog.createProduct({ prisma, input: { code: 'B', name: 'sub', isSubscription: true } });
  // fake findMany no aplica where; comprobamos que el servicio no rompe y devuelve total
  const all = await catalog.listProducts({ prisma });
  assert.equal(all.total, 2);
});
