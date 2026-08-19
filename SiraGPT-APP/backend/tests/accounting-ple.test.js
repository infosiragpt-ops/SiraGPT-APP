'use strict';

/**
 * Libros electrónicos PLE (SUNAT) — Registro de Ventas y Compras. Estructura de
 * campos pipe-delimited, codificación de tipos (comprobante/documento), montos.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ple = require('../src/services/accounting/ple');

test('mapDocType: factura=01, boleta=03', () => {
  assert.equal(ple.mapDocType('FACTURA'), '01');
  assert.equal(ple.mapDocType('BOLETA'), '03');
  assert.equal(ple.mapDocType('NOTA_CREDITO'), '07');
});

test('mapDocClientType: RUC=6, DNI=1, CE=4, sin doc=0', () => {
  assert.equal(ple.mapDocClientType('RUC'), '6');
  assert.equal(ple.mapDocClientType('DNI'), '1');
  assert.equal(ple.mapDocClientType('CE'), '4');
  assert.equal(ple.mapDocClientType('PASAPORTE'), '7');
  assert.equal(ple.mapDocClientType('SIN_DOC'), '0');
});

test('fmtDate / fmtAmount / periodoField', () => {
  assert.equal(ple.fmtDate(new Date('2026-06-15T00:00:00Z')), '15/06/2026');
  assert.equal(ple.fmtAmount(118), '118.00');
  assert.equal(ple.fmtAmount(33.335), '33.34');
  assert.equal(ple.periodoField('202606'), '20260600');
});

const invoice = {
  docType: 'FACTURA', series: 'F001', number: 8, issueDate: new Date('2026-06-15T00:00:00Z'),
  customerDocType: 'RUC', customerDoc: '20512345678', customerName: 'ACME SAC',
  gravado: 100, igv: 18, exonerado: 0, inafecto: 0, total: 118, exchangeRate: null,
};

test('buildVentasLine: estructura y campos correctos', () => {
  const line = ple.buildVentasLine(invoice, { periodo: '202606', cuo: 1 });
  const f = line.split('|');
  // termina en '|'
  assert.equal(line.endsWith('|'), true);
  assert.equal(f[0], '20260600');     // periodo
  assert.equal(f[1], '1');            // CUO
  assert.equal(f[3], '15/06/2026');   // fecha emisión
  assert.equal(f[4], '01');           // tipo comprobante (factura)
  assert.equal(f[5], 'F001');         // serie
  assert.equal(f[6], '8');            // número
  assert.equal(f[7], '6');            // tipo doc cliente (RUC)
  assert.equal(f[8], '20512345678');  // num doc
  assert.equal(f[9], 'ACME SAC');     // nombre
  assert.equal(f[10], '100.00');      // gravado
  assert.equal(f[11], '18.00');       // IGV
  assert.equal(f[14], '118.00');      // total
  assert.equal(f[15], '1.00');        // tipo de cambio
  assert.equal(f[16], '1');           // estado
});

test('buildVentasPle: una línea por comprobante, CRLF', () => {
  const text = ple.buildVentasPle([invoice, { ...invoice, number: 9 }], { periodo: '202606' });
  const lines = text.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('|F001|8|'));
  assert.ok(lines[1].includes('|F001|9|'));
});

test('buildVentasPle: vacío → cadena vacía', () => {
  assert.equal(ple.buildVentasPle([], { periodo: '202606' }), '');
});

test('buildComprasPle: registro de compras con crédito fiscal', () => {
  const purchase = { date: new Date('2026-06-10T00:00:00Z'), docType: 'FACTURA', serie: 'F500', numero: 12, supplierDocType: 'RUC', supplierDoc: '20100000001', supplierName: 'Proveedor SAC', gravado: 200, igv: 36, exonerado: 0, inafecto: 0, total: 236, exchangeRate: null };
  const text = ple.buildComprasPle([purchase], { periodo: '202606' });
  const f = text.trim().split('|');
  assert.equal(f[4], '01');
  assert.equal(f[10], '200.00'); // base
  assert.equal(f[11], '36.00');  // IGV crédito fiscal
  assert.equal(f[14], '236.00'); // total
});

test('generateVentasPle: arma desde comprobantes ISSUED del periodo (fakePrisma)', async () => {
  const prisma = {
    accountingInvoice: {
      findMany: async ({ where }) => {
        assert.equal(where.status, 'ISSUED');
        assert.ok(where.issueDate.gte instanceof Date && where.issueDate.lte instanceof Date);
        return [invoice];
      },
    },
  };
  const text = await ple.generateVentasPle({ prisma, periodo: '202606' });
  assert.ok(text.includes('20260600|1|'));
  assert.ok(text.includes('20512345678'));
});

test('periodBounds: límites del mes', () => {
  const { start, end } = ple.periodBounds('202602');
  assert.equal(start.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-02-28T23:59:59.999Z');
});
