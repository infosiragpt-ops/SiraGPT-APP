'use strict';

const { round2, sum2 } = require('./money');

/**
 * IGV (Impuesto General a las Ventas) peruano — 18% por defecto.
 * El precio unitario se interpreta SIN IGV (valor de venta neto).
 * Tipos de afectación: GRAVADO (afecto 18%), EXONERADO, INAFECTO.
 * Redondeo a nivel de línea (convención SUNAT).
 */

const IGV_RATE = Number(process.env.IGV_RATE || 0.18);
const TAX_TYPES = ['GRAVADO', 'EXONERADO', 'INAFECTO'];

/** Calcula base imponible, IGV y total de una línea. */
function computeLineTax({ quantity = 1, unitPrice = 0, taxType = 'GRAVADO' } = {}, rate = IGV_RATE) {
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const tt = TAX_TYPES.includes(taxType) ? taxType : 'GRAVADO';
  const base = round2(qty * price);
  const igv = tt === 'GRAVADO' ? round2(base * rate) : 0;
  const total = round2(base + igv);
  return { base, igv, total, taxType: tt };
}

/**
 * Calcula totales de un comprobante a partir de sus líneas.
 * @returns {{lines, gravado, exonerado, inafecto, igv, total, rate}}
 */
function computeInvoiceTotals(lines, rate = IGV_RATE) {
  const computed = (Array.isArray(lines) ? lines : []).map((l) => {
    const tax = computeLineTax(l, rate);
    return { ...l, ...tax };
  });
  const byType = (t) => computed.filter((l) => l.taxType === t).map((l) => l.base);
  return {
    lines: computed,
    gravado: sum2(byType('GRAVADO')),
    exonerado: sum2(byType('EXONERADO')),
    inafecto: sum2(byType('INAFECTO')),
    igv: sum2(computed.map((l) => l.igv)),
    total: sum2(computed.map((l) => l.total)),
    rate,
  };
}

module.exports = { IGV_RATE, TAX_TYPES, computeLineTax, computeInvoiceTotals };
