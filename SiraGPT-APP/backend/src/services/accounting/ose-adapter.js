'use strict';

const crypto = require('crypto');

/**
 * Adaptador OSE/PSE (Operador/Proveedor de Servicios Electrónicos) para la
 * emisión de comprobantes electrónicos a SUNAT.
 *
 * Interfaz que todo proveedor debe implementar:
 *   async emit(invoice) → { success, sunatStatus, ticket, cdrHash, provider, raw }
 *   async voidInvoice(invoice, reason) → { success, ticket }
 *
 * Selección por env OSE_PROVIDER (default 'stub'). Credenciales por env:
 *   OSE_PROVIDER   stub | nubefact
 *   OSE_RUC        RUC del emisor
 *   OSE_USER       usuario/SOL secundario
 *   OSE_TOKEN      token/clave del OSE
 *   OSE_BASE_URL   endpoint del proveedor
 *
 * Para conectar un proveedor real (ej. NubeFact): implementar createNubefactAdapter
 * (ver puntos de extensión más abajo) y exportarlo en PROVIDERS.
 */

/** Stub funcional: simula la aceptación de SUNAT de forma determinista (sin red). */
function createStubAdapter() {
  return {
    name: 'stub',
    async emit(invoice) {
      const id = `${invoice.series}-${invoice.number}`;
      const cdrHash = crypto.createHash('sha1').update(`${id}:${invoice.total}`).digest('hex');
      return {
        success: true,
        provider: 'stub',
        sunatStatus: 'ACCEPTED',
        ticket: `STUB-${cdrHash.slice(0, 12).toUpperCase()}`,
        cdrHash,
        raw: { note: 'Comprobante aceptado por el OSE stub (simulado).', id },
      };
    },
    async voidInvoice(invoice) {
      return { success: true, provider: 'stub', ticket: `STUB-VOID-${invoice.series}-${invoice.number}` };
    },
  };
}

/**
 * Punto de extensión — NubeFact (PSE real).
 * Para activarlo: setear OSE_PROVIDER=nubefact + OSE_BASE_URL (URL de la API
 * "Operaciones" de NubeFact) + OSE_TOKEN. Implementar el mapeo del invoice al
 * payload de NubeFact (operacion: 'generar_comprobante', tipo_de_comprobante
 * 1=factura/2=boleta, serie, numero, sunat_transaction, cliente_*, items[],
 * total_gravada/igv/total) y hacer POST con fetch al endpoint con el token en
 * el body, parseando la respuesta (aceptada_por_sunat, sunat_responsecode,
 * enlace_del_pdf). Hoy lanza NOT_CONFIGURED hasta implementarse.
 */
function createNubefactAdapter(env = process.env) {
  return {
    name: 'nubefact',
    async emit() {
      const err = new Error('Proveedor NubeFact no implementado todavía. Configure OSE_BASE_URL/OSE_TOKEN e implemente el mapeo del comprobante en createNubefactAdapter.');
      err.code = 'OSE_NOT_CONFIGURED';
      err.hints = { OSE_BASE_URL: Boolean(env.OSE_BASE_URL), OSE_TOKEN: Boolean(env.OSE_TOKEN) };
      throw err;
    },
    async voidInvoice() {
      const err = new Error('Anulación NubeFact no implementada todavía.');
      err.code = 'OSE_NOT_CONFIGURED';
      throw err;
    },
  };
}

/** Resuelve el adaptador OSE según OSE_PROVIDER (default stub). Inyectable. */
function getOseAdapter(env = process.env) {
  const provider = String(env.OSE_PROVIDER || 'stub').toLowerCase();
  switch (provider) {
    case 'nubefact':
      return createNubefactAdapter(env);
    case 'stub':
    default:
      return createStubAdapter();
  }
}

module.exports = { getOseAdapter, createStubAdapter, createNubefactAdapter };
