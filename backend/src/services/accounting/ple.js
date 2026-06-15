'use strict';

const { round2 } = require('./money');

/**
 * Libros electrónicos PLE (Programa de Libros Electrónicos) de SUNAT.
 * Genera texto plano pipe-delimited (cada registro termina en `|`, líneas con
 * CRLF) para el Registro de Ventas e Ingresos (14.1) y el Registro de Compras
 * (8.1). Implementación faithful de los campos clave; cada línea = un comprobante.
 */

const CRLF = '\r\n';

// Tabla 10 SUNAT (tipo de comprobante) — los más comunes.
function mapDocType(docType) {
  switch (String(docType || '').toUpperCase()) {
    case 'FACTURA': return '01';
    case 'BOLETA': return '03';
    case 'NOTA_CREDITO': return '07';
    case 'NOTA_DEBITO': return '08';
    default: return String(docType || '00');
  }
}

// Tabla 2 SUNAT (tipo de documento de identidad).
function mapDocClientType(custDocType) {
  switch (String(custDocType || '').toUpperCase()) {
    case 'RUC': return '6';
    case 'DNI': return '1';
    case 'CE': return '4';
    case 'PASAPORTE': return '7';
    default: return '0'; // SIN_DOC / otros
  }
}

function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

function fmtAmount(n) {
  return round2(n || 0).toFixed(2);
}

/** Campo "periodo" del PLE: AAAAMM00. */
function periodoField(periodo) {
  const p = String(periodo || '').replace(/\D/g, '').slice(0, 6);
  return `${p}00`;
}

function row(fields) {
  return fields.join('|') + '|';
}

/** Línea del Registro de Ventas para un comprobante. */
function buildVentasLine(invoice, { periodo, cuo }) {
  return row([
    periodoField(periodo),                       // periodo
    cuo,                                          // CUO (código único de operación)
    'M' + String(cuo),                            // número correlativo del asiento
    fmtDate(invoice.issueDate),                   // fecha de emisión
    mapDocType(invoice.docType),                  // tipo de comprobante
    invoice.series,                               // serie
    String(invoice.number),                       // número
    mapDocClientType(invoice.customerDocType || (invoice.customerDoc && invoice.customerDoc.length === 11 ? 'RUC' : invoice.customerDoc && invoice.customerDoc.length === 8 ? 'DNI' : 'SIN_DOC')),
    invoice.customerDoc || '0',                   // número de documento del cliente
    invoice.customerName || '',                   // nombre/razón social
    fmtAmount(invoice.gravado),                   // base imponible gravada
    fmtAmount(invoice.igv),                       // IGV
    fmtAmount(invoice.exonerado),                 // valor exonerado
    fmtAmount(invoice.inafecto),                  // valor inafecto
    fmtAmount(invoice.total),                     // importe total
    invoice.exchangeRate != null ? fmtAmount(invoice.exchangeRate) : '1.00', // tipo de cambio
    '1',                                          // estado (1 = registro válido)
  ]);
}

/** Texto PLE del Registro de Ventas e Ingresos. */
function buildVentasPle(invoices, { periodo } = {}) {
  const lines = (Array.isArray(invoices) ? invoices : []).map((inv, i) => buildVentasLine(inv, { periodo, cuo: i + 1 }));
  return lines.join(CRLF) + (lines.length ? CRLF : '');
}

/** Línea del Registro de Compras para un comprobante de compra. */
function buildComprasLine(purchase, { periodo, cuo }) {
  return row([
    periodoField(periodo),
    cuo,
    'M' + String(cuo),
    fmtDate(purchase.date),
    mapDocType(purchase.docType),
    purchase.serie || '',
    String(purchase.numero || ''),
    mapDocClientType(purchase.supplierDocType || 'RUC'),
    purchase.supplierDoc || '0',
    purchase.supplierName || '',
    fmtAmount(purchase.gravado),                  // base imponible (gravada)
    fmtAmount(purchase.igv),                      // IGV (crédito fiscal)
    fmtAmount(purchase.exonerado),
    fmtAmount(purchase.inafecto),
    fmtAmount(purchase.total),
    purchase.exchangeRate != null ? fmtAmount(purchase.exchangeRate) : '1.00',
    '1',
  ]);
}

/** Texto PLE del Registro de Compras. */
function buildComprasPle(purchases, { periodo } = {}) {
  const lines = (Array.isArray(purchases) ? purchases : []).map((p, i) => buildComprasLine(p, { periodo, cuo: i + 1 }));
  return lines.join(CRLF) + (lines.length ? CRLF : '');
}

// ── Prisma-backed ────────────────────────────────────────────────────────────
function periodBounds(periodo) {
  const p = String(periodo || '').replace(/\D/g, '');
  const year = Number(p.slice(0, 4));
  const month = Number(p.slice(4, 6));
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)) };
}

/** Genera el PLE de ventas de un periodo desde los comprobantes emitidos. */
async function generateVentasPle({ prisma, periodo } = {}) {
  if (!prisma) throw new Error('prisma requerido');
  const { start, end } = periodBounds(periodo);
  const invoices = await prisma.accountingInvoice.findMany({
    where: { status: 'ISSUED', issueDate: { gte: start, lte: end } },
    orderBy: [{ series: 'asc' }, { number: 'asc' }],
  });
  return buildVentasPle(invoices, { periodo });
}

/**
 * Genera el PLE de compras. Un módulo de compras completo (registro de
 * comprobantes de proveedores) es una extensión futura; por ahora acepta una
 * lista de registros de compra ya capturados.
 */
async function generateComprasPle({ purchases = [], periodo } = {}) {
  return buildComprasPle(purchases, { periodo });
}

module.exports = {
  mapDocType,
  mapDocClientType,
  fmtDate,
  fmtAmount,
  periodoField,
  buildVentasLine,
  buildVentasPle,
  buildComprasLine,
  buildComprasPle,
  periodBounds,
  generateVentasPle,
  generateComprasPle,
};
