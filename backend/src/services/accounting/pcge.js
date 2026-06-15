'use strict';

const { accountElement, accountLevel, parentCode } = require('./double-entry');

/**
 * Plan Contable General Empresarial (PCGE) peruano — catálogo base.
 * Nivel 1 = elemento/clase (1..9); nivel 2 = cuentas de 2 dígitos.
 * `type`/`nature` por defecto se derivan del elemento; las cuentas de
 * regularización (contra-activo / contra-ingreso) llevan override explícito.
 */

// Elemento → { name, type, nature } por defecto.
const ELEMENTS = {
  1: { name: 'Activo disponible y exigible', type: 'ACTIVO', nature: 'DEUDORA' },
  2: { name: 'Activo realizable', type: 'ACTIVO', nature: 'DEUDORA' },
  3: { name: 'Activo inmovilizado', type: 'ACTIVO', nature: 'DEUDORA' },
  4: { name: 'Pasivo', type: 'PASIVO', nature: 'ACREEDORA' },
  5: { name: 'Patrimonio neto', type: 'PATRIMONIO', nature: 'ACREEDORA' },
  6: { name: 'Gastos por naturaleza', type: 'GASTO', nature: 'DEUDORA' },
  7: { name: 'Ingresos', type: 'INGRESO', nature: 'ACREEDORA' },
  8: { name: 'Saldos intermediarios de gestión y determinación del resultado', type: 'RESULTADO', nature: 'DEUDORA' },
  9: { name: 'Contabilidad analítica de explotación (costos)', type: 'COSTO', nature: 'DEUDORA' },
};

// Cuentas de 2 dígitos. `nature`/`type` opcionales solo cuando difieren del elemento.
const TWO_DIGIT = [
  // Elemento 1
  ['10', 'Efectivo y equivalentes de efectivo'],
  ['11', 'Inversiones financieras'],
  ['12', 'Cuentas por cobrar comerciales - terceros'],
  ['13', 'Cuentas por cobrar comerciales - relacionadas'],
  ['14', 'Cuentas por cobrar al personal, accionistas, directores y gerentes'],
  ['16', 'Cuentas por cobrar diversas - terceros'],
  ['17', 'Cuentas por cobrar diversas - relacionadas'],
  ['18', 'Servicios y otros contratados por anticipado'],
  ['19', 'Estimación de cuentas de cobranza dudosa', { nature: 'ACREEDORA' }],
  // Elemento 2
  ['20', 'Mercaderías'],
  ['21', 'Productos terminados'],
  ['22', 'Subproductos, desechos y desperdicios'],
  ['23', 'Productos en proceso'],
  ['24', 'Materias primas'],
  ['25', 'Materiales auxiliares, suministros y repuestos'],
  ['26', 'Envases y embalajes'],
  ['27', 'Activos no corrientes mantenidos para la venta'],
  ['28', 'Existencias por recibir'],
  ['29', 'Desvalorización de existencias', { nature: 'ACREEDORA' }],
  // Elemento 3
  ['30', 'Inversiones mobiliarias'],
  ['31', 'Inversiones inmobiliarias'],
  ['32', 'Activos adquiridos en arrendamiento financiero'],
  ['33', 'Inmuebles, maquinaria y equipo'],
  ['34', 'Intangibles'],
  ['35', 'Activos biológicos'],
  ['36', 'Desvalorización de activo inmovilizado', { nature: 'ACREEDORA' }],
  ['37', 'Activo diferido'],
  ['38', 'Otros activos'],
  ['39', 'Depreciación, amortización y agotamiento acumulados', { nature: 'ACREEDORA' }],
  // Elemento 4
  ['40', 'Tributos, contraprestaciones y aportes al sistema de pensiones y de salud por pagar'],
  ['41', 'Remuneraciones y participaciones por pagar'],
  ['42', 'Cuentas por pagar comerciales - terceros'],
  ['43', 'Cuentas por pagar comerciales - relacionadas'],
  ['44', 'Cuentas por pagar a los accionistas, directores y gerentes'],
  ['45', 'Obligaciones financieras'],
  ['46', 'Cuentas por pagar diversas - terceros'],
  ['47', 'Cuentas por pagar diversas - relacionadas'],
  ['48', 'Provisiones'],
  ['49', 'Pasivo diferido'],
  // Elemento 5
  ['50', 'Capital'],
  ['51', 'Acciones de inversión'],
  ['52', 'Capital adicional'],
  ['56', 'Resultados no realizados'],
  ['57', 'Excedente de revaluación'],
  ['58', 'Reservas'],
  ['59', 'Resultados acumulados'],
  // Elemento 6
  ['60', 'Compras'],
  ['61', 'Variación de existencias'],
  ['62', 'Gastos de personal, directores y gerentes'],
  ['63', 'Gastos de servicios prestados por terceros'],
  ['64', 'Gastos por tributos'],
  ['65', 'Otros gastos de gestión'],
  ['66', 'Pérdida por medición de activos no financieros al valor razonable'],
  ['67', 'Gastos financieros'],
  ['68', 'Valuación y deterioro de activos y provisiones'],
  ['69', 'Costo de ventas'],
  // Elemento 7
  ['70', 'Ventas'],
  ['71', 'Variación de la producción almacenada'],
  ['72', 'Producción de activo inmovilizado'],
  ['73', 'Descuentos, rebajas y bonificaciones obtenidos'],
  ['74', 'Descuentos, rebajas y bonificaciones concedidos', { nature: 'DEUDORA' }],
  ['75', 'Otros ingresos de gestión'],
  ['76', 'Ganancia por medición de activos no financieros al valor razonable'],
  ['77', 'Ingresos financieros'],
  ['78', 'Cargas cubiertas por provisiones'],
  ['79', 'Cargas imputables a cuentas de costos y gastos', { nature: 'ACREEDORA' }],
  // Elemento 8
  ['80', 'Margen comercial'],
  ['81', 'Producción del ejercicio'],
  ['82', 'Valor agregado'],
  ['83', 'Excedente bruto (insuficiencia bruta) de explotación'],
  ['84', 'Resultado de explotación'],
  ['85', 'Resultado antes de participaciones e impuestos'],
  ['87', 'Participaciones de los trabajadores'],
  ['88', 'Impuesto a la renta'],
  ['89', 'Determinación del resultado del ejercicio'],
  // Elemento 9 (analítica de explotación — definible por la empresa)
  ['90', 'Gastos por aplicar'],
  ['92', 'Costo de producción'],
  ['94', 'Gastos de administración'],
  ['95', 'Gastos de ventas'],
  ['97', 'Gastos financieros'],
];

/** Devuelve el catálogo completo (elementos + cuentas de 2 dígitos) como filas. */
function pcgeAccounts() {
  const rows = [];
  // Nivel 1 — elementos.
  for (const [elStr, meta] of Object.entries(ELEMENTS)) {
    const el = Number(elStr);
    rows.push({
      code: elStr,
      name: meta.name,
      element: el,
      level: 1,
      parentCode: null,
      nature: meta.nature,
      type: meta.type,
      postable: false,
    });
  }
  // Nivel 2 — cuentas de 2 dígitos.
  for (const [code, name, override] of TWO_DIGIT) {
    const el = accountElement(code);
    const meta = ELEMENTS[el] || {};
    rows.push({
      code,
      name,
      element: el,
      level: accountLevel(code),
      parentCode: parentCode(code),
      nature: (override && override.nature) || meta.nature,
      type: (override && override.type) || meta.type,
      postable: false, // las cuentas de detalle (4+ dígitos) se marcan postable en ítems posteriores
    });
  }
  return rows;
}

/**
 * Idempotently upsert the PCGE base catalog. Injectable Prisma client.
 * @returns {Promise<{count:number}>}
 */
async function seedPcge(prisma) {
  const rows = pcgeAccounts();
  for (const row of rows) {
    await prisma.accountingAccount.upsert({
      where: { code: row.code },
      update: { name: row.name, element: row.element, level: row.level, parentCode: row.parentCode, nature: row.nature, type: row.type },
      create: row,
    });
  }
  return { count: rows.length };
}

module.exports = { ELEMENTS, TWO_DIGIT, pcgeAccounts, seedPcge };
