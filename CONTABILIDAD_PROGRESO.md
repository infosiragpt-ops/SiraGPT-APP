# Sistema Contable siraGPT — Backlog vivo y registro de avance

Rama: `feat/contabilidad`. Estándar PCGE peruano, partida doble, facturación
electrónica con IGV, libros PLE, reportes financieros.

## Decisiones de arquitectura (conforme al stack existente)

El repo es un **híbrido**: el frontend Next.js 15 (App Router, `app/`) NO accede a
la DB directamente (`lib/prisma.ts` está comentado, sin `@prisma/client` en la
raíz); llama al **backend Express** (`backend/`, vía `lib/api.ts` → `localhost:5000`)
que es el dueño de **Prisma + PostgreSQL + migraciones** (`backend/prisma/`).

Por tanto, "conforme exactamente al stack y convenciones ya presentes":

- **Modelo de datos + migraciones:** `backend/prisma/schema.prisma` (+ `migrations/`).
- **Dominio + persistencia + API:** backend (`backend/src/services/accounting/*`,
  `backend/src/routes/accounting.js`) con **zod** (ya presente en backend) para
  validación de entrada. La generic-spec pedía "server actions/route handlers de
  Next.js"; se **adapta** a rutas Express + zod porque ahí vive el ORM (la
  alternativa —segundo cliente Prisma en Next.js sobre la misma DB— rompería las
  convenciones y la gestión única de migraciones).
- **Lógica contable pura** (debe=haber, IGV, redondeo, reportes) en módulos puros
  testeables sin DB.
- **UI:** Next.js `app/contabilidad/` con el design system existente
  (`components/ui`), consumiendo el backend vía `lib/api.ts`. Export Excel
  (`exceljs`) y PDF (`pdfkit`/`pdf-lib`), todas libs ya presentes en backend.
- **Aritmética monetaria exacta:** `decimal.js` (se añade al backend) o céntimos
  enteros; nunca floats crudos para dinero/IGV.

### Seguridad de migraciones
`backend/.env` `DATABASE_URL` apunta a `localhost` y el client `@prisma/client`
está **symlinkeado** (compartido con el repo principal). Para no mutar prod/DB
local ni el client compartido: las migraciones se **generan** con
`prisma migrate diff --from-schema-datamodel ... --to-schema-datamodel ... --script`
(sin conexión a DB) y se **aplican vía el pipeline de deploy** (`prisma migrate
deploy`), no desde esta sesión. Se valida con `prisma validate`.

### Verificación por ítem
`npm run type-check` · `npm run lint` · backend `npm test` (node --test, registrar
los archivos nuevos en `backend/package.json`) · `npm run test:unit` (vitest) ·
`npm run build`. Commit convencional `feat(contabilidad): ...` + actualizar este
archivo.

## Backlog

- [x] **1. Cimientos — Plan de cuentas PCGE + partida doble** ✅
      Modelos Prisma `AccountingAccount` (jerárquico), `AccountingJournalEntry`,
      `AccountingJournalLine` + migración `…_add_accounting_core` (generada
      offline). Lógica pura: `money.js` (dinero exacto por céntimos),
      `double-entry.js` (`validateBalanced`/`assertBalanced` Σdebe=Σhaber +
      helpers element/level/parent), `pcge.js` (catálogo PCGE: 9 elementos + 65
      cuentas de 2 dígitos, overrides de naturaleza para contra-cuentas, +
      `seedPcge`). Tests `accounting-core.test.js` (12, node --test, verde).
- [x] **2. Libro Diario** ✅ — `journal.js`: `createJournalEntry` (zod +
      `assertBalanced` Σdebe=Σhaber + resolución de cuentas por código +
      numeración correlativa global + persistencia atómica entry+lines),
      `listJournalEntries`, `getJournalEntry`. Ruta `accounting.js`
      (`/api/accounting/journal-entries` POST/GET/:id, `/accounts`,
      `/accounts/seed`) montada en index.js, auth + mapeo de errores
      (400/422/404). Tests `accounting-journal.test.js` (7, node --test).
- [x] **3. Libro Mayor** ✅ — `ledger.js`: `buildLedger` (agregación pura por
      cuenta, saldo firmado por naturaleza DEUDORA/ACREEDORA), `buildTrialBalance`
      (balance de comprobación con reconciliación Σdebe=Σhaber),
      `computeLedger`/`computeTrialBalance` (prisma, sólo asientos POSTED).
      Rutas `/api/accounting/ledger[/:code]` + `/trial-balance`. Tests
      `accounting-ledger.test.js` (6, node --test).
- [x] **4. Periodos contables** ✅ — modelo Prisma `AccountingPeriod`
      (year/month únicos, OPEN/CLOSED) + migración offline. `periods.js`:
      openPeriod/closePeriod (idempotentes), findPeriodForDate, `assertDateOpen`
      (lanza PERIOD_CLOSED). Integrado en `journal.createJournalEntry` (bloquea
      asientos en periodo cerrado + setea periodId del periodo abierto). Rutas
      `/api/accounting/periods[/open|/close]`. Tests `accounting-periods.test.js`
      (7) + regresión del diario verde.
- [x] **5. Multimoneda PEN/USD** ✅ — modelo Prisma `AccountingExchangeRate`
      (date/currency/rateType únicos, COMPRA/VENTA, source SUNAT/SBS/MANUAL) +
      migración offline. `exchange-rate.js`: `recordRate` (zod+upsert),
      `getRate` (match exacto o más reciente ≤ fecha), `convertWithRate`/
      `convertAmount` (PEN↔extranjera exacto). Rutas
      `/api/accounting/exchange-rates[/lookup]`. Tests
      `accounting-exchange-rate.test.js` (6). (El diario ya acepta currency+TC).
- [x] **6. Clientes + catálogo de productos/servicios** ✅ — modelos Prisma
      `AccountingCustomer` (docType RUC/DNI/CE/PASAPORTE/SIN_DOC únicos) y
      `AccountingProduct` (kind, unitPrice, currency, unit SUNAT, igvAffected,
      `isSubscription` para suscripciones del SaaS, incomeAccount) + migración
      offline. `catalog.js`: validación de documento peruano (RUC 11 díg/DNI 8),
      CRUD con zod. Rutas `/api/accounting/customers` y `/products`
      (GET/POST/GET:id/PATCH). Tests `accounting-catalog.test.js` (8).
- [x] **7. Facturación + comprobantes electrónicos** ✅ — `igv.js` (IGV 18%
      exacto por línea con money.js; GRAVADO/EXONERADO/INAFECTO; totales por
      afectación). Modelos Prisma `AccountingInvoice` (BOLETA/FACTURA, serie,
      correlativo, totales, status DRAFT/ISSUED/VOID, sunatStatus/ticket/CDR) +
      `AccountingInvoiceLine` + migración offline. `invoicing.js`: createInvoice
      (zod + IGV + numeración por serie + FACTURA exige RUC), issueInvoice
      (emite vía OSE), list/get. `ose-adapter.js`: interfaz + **stub funcional**
      (CDR simulado) + envs (OSE_PROVIDER/RUC/USER/TOKEN/BASE_URL) + punto de
      extensión NubeFact documentado. Rutas `/api/accounting/invoices[/:id/issue]`.
      Tests `accounting-invoicing.test.js` (10).
- [x] **8. Asiento automático por venta/cobro** ✅ — `auto-journal.js`:
      `invoiceToJournalLines` (cargo 1212 CxC=total, abono 7011 Ventas=base,
      abono 40111 IGV; Σdebe=Σhaber), `postInvoiceSale` (asiento SALE + enlaza
      journalEntryId, idempotente), `registerPayment` (cobro: cargo 1011/1041
      Efectivo, abono 1212; source PAYMENT). Integrado en `issueInvoice`
      (contabiliza tras emitir, tolerante). Cuentas de detalle PCGE añadidas al
      seed (1011/1041/1212/40111/4212/6011/7011/7041, postable). Ruta
      `/api/accounting/invoices/:id/payment`. Tests `accounting-auto-journal`
      (5). Suite contable completa: 61/61.
- [x] **9. Libros electrónicos PLE** ✅ — `ple.js`: generadores pipe-delimited
      formato SUNAT — `buildVentasPle` (Registro de Ventas e Ingresos) +
      `buildComprasPle` (Registro de Compras) con codificación de tipo de
      comprobante (01/03/07/08) y de documento (Tabla 2: RUC=6/DNI=1/CE=4),
      fechas dd/mm/aaaa, montos a 2 dec, periodo AAAAMM00. `generateVentasPle`
      arma desde comprobantes ISSUED del periodo; compras acepta registros
      (módulo de compras = extensión futura, documentado). Rutas
      `/api/accounting/ple/ventas` y `/ple/compras` (param periodo). Tests
      `accounting-ple.test.js` (9).
- [x] **10. Reportes financieros** ✅ — `reports.js` (puras + wrappers prisma
      sobre `ledger`): `incomeStatement` (ingresos elem.7 neto de 74 − gastos
      elem.6 → utilidad), `balanceSheet` (activo 1/2/3 vs pasivo 4 + patrimonio 5
      + resultado, con reconciliación `activo = pasivo+patrimonio+resultado`),
      `cashFlow` (movimientos de efectivo clase 10). Rutas
      `/api/accounting/reports/{income-statement,balance-sheet,cash-flow}`.
      Tests `accounting-reports.test.js` (6) — reconciliación verificada. Suite
      contable: **76/76**.
- [x] **11. UI Next.js + exportación** ✅ — backend `exporters.js` (Excel via
      exceljs: diario/balance de comprobación/comprobantes; PDF via pdfkit:
      estado de resultados/balance general) + rutas `/api/accounting/export/*`
      + tests (5). `lib/api.ts` métodos contables + `downloadAccountingExport`.
      UI `app/contabilidad/page.tsx` (design system existente): KPIs
      (ingresos/gastos/utilidad/activo) + pestañas Asientos/Comprobantes/Reportes
      con tablas + botones de export Excel/PDF. tsc 0, lint limpio, UI-lock
      re-baselineado. Suite contable: **81/81**.
- [ ] **12. Cierre** — push rama, PR, CI verde, merge a main.

## Registro de avance

- 2026-06-15 — Inspección del stack + decisiones de arquitectura. Rama
  `feat/contabilidad` creada desde `eca9d97e4`. Backlog inicial. (en progreso)
