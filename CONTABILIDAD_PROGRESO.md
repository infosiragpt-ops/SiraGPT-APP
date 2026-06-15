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
- [ ] **5. Multimoneda PEN/USD** — registro de tipo de cambio, conversión; modelo
      + servicio + tests.
- [ ] **6. Clientes + catálogo de productos/servicios** (incl. suscripciones del
      SaaS); modelos + CRUD + tests.
- [ ] **7. Facturación + comprobantes electrónicos** (boleta/factura) + IGV 18%
      exacto + adaptador OSE/PSE (interfaz + stub funcional + envs + puntos de
      extensión para NubeFact); modelos + cálculo IGV + tests.
- [ ] **8. Asiento automático por venta/cobro** — al emitir/cobrar genera el
      asiento contable; servicio + tests.
- [ ] **9. Libros electrónicos PLE** (ventas/compras) formato SUNAT; generadores
      + tests.
- [ ] **10. Reportes financieros** — estado de resultados, balance general, flujo
      de caja; reconcilian con el mayor; servicios + tests.
- [ ] **11. UI Next.js** — dashboard contable, tablas de asientos/comprobantes,
      export Excel/PDF.
- [ ] **12. Cierre** — push rama, PR, CI verde, merge a main.

## Registro de avance

- 2026-06-15 — Inspección del stack + decisiones de arquitectura. Rama
  `feat/contabilidad` creada desde `eca9d97e4`. Backlog inicial. (en progreso)
