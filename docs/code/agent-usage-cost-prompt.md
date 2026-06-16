# Prompt — Resumen de ejecución con "Agent Usage" (costo IA) en `/code`

> **Alcance estricto:** SOLO el chat/agente de `http://localhost:3000/code`
> (subsistema **Codex Agent V2**, flag `CODEX_AGENT_V2`). No tocar otras rutas,
> otros chats, ni componentes fuera de `components/codex/**` y
> `backend/src/services/codex/**`. Mantener CI verde (`npm test` + `npm run lint`).

---

## Contexto: qué YA existe (no reconstruir)

El panel "Worked for N" del resumen final **ya está implementado** y ya muestra
una fila "Agent Usage". Antes de escribir código, leer:

- **UI del panel:** `components/codex/run-summary-card.tsx`
  Ya renderiza: Time worked, Work done (acciones), Items read (líneas),
  Code changed (`+add −del`) y **Agent Usage** (costo aplicado, costo original
  tachado cuando difiere, badge "estimado"). Tema oscuro, colapsable, `formatUsd`.
- **Acumulador backend:** `backend/src/services/codex/run-metrics.js`
  `createAccumulator()` con `recordAction` / `recordLinesRead` / `recordLlmUsage`
  y `finalize()` → calcula `timeWorkedMs`, dobla el diffstat, resuelve costo por
  llamada LLM, aplica multiplicador de plan, hace upsert de `CodexRunMetric` y
  emite el evento `run_summary`.
- **Escalera de costo:** `backend/src/services/codex/cost-resolver.js`
  `provider_exact` → `openrouter_generation` → `estimated`. Cumple requisitos #3 y #4.
- **Política de precio por plan:** `backend/src/services/codex/pricing-policy.js`
  (`costOriginalUsd` → `costAppliedUsd`).
- **Tipo + persistencia:** `lib/codex/codex-api.ts` (`CodexRunMetric`) y el modelo
  Prisma `CodexRunMetric` (`backend/prisma/schema.prisma`, ~línea 2010). Ya
  persisten `tokensIn`, `tokensOut`, `costUsd`, `costSource`, `costOriginalUsd`,
  `costAppliedUsd`.
- **Formato:** `lib/codex/format.ts` (`formatUsd`, `humanizeDuration`,
  `shouldStrikethrough`).
- **Captura de uso LLM:** `backend/src/services/codex/llm-turn.js` `extractUsage()`
  ya devuelve `{ tokensIn, tokensOut, model }` por paso.

**Requisitos del spec ya cubiertos:** #1 (costo total), #3 (usar uso del
proveedor), #4 (fallback a tabla de precios), #5 (sección Agent Usage), #6 (tema
oscuro), #7 (formato `$0.00`), #8 (se actualiza tras cada ejecución vía evento
`run_summary`).

---

## Objetivo: cerrar las 3 brechas restantes

### Brecha A — Costo de entrada y salida por separado (requisito #2)
Hoy `resolveCost()` devuelve un único `costUsd` total por llamada. Hay que
exponer también el costo atribuible a tokens de entrada y a tokens de salida.

- En `cost-resolver.js`, extender el retorno de `resolveCost()` a
  `{ costUsd, costInputUsd, costOutputUsd, costSource }`:
  - `provider_exact` con `costUsd` directo: si el proveedor no da el desglose,
    repartir `costUsd` proporcional a `tokensIn`/`tokensOut`; si da
    `inputCost`/`outputCost`, usarlos tal cual.
  - Proveedor gratuito (`FREE_PROVIDERS`): los tres en 0.
  - `openrouter_generation`: usar `prompt_cost` / `completion_cost` del body si
    vienen; si no, repartir el `total_cost` proporcional a tokens.
  - `estimated`: derivar del precio por dirección del modelo (ver Brecha B);
    si no hay tarifa por dirección, repartir el estimado por proporción de tokens.
- En `run-metrics.js` `finalize()`, acumular `costInputUsd` y `costOutputUsd`
  sumando los de cada llamada, aplicarles el mismo multiplicador de plan que a
  `costOriginalUsd` (reutilizar `applyPlanPricing` o factorizar un helper) y
  agregarlos al objeto `metric`.

### Brecha B — Detalle expandible: modelo + tokens + costos (requisito #10)
El panel debe permitir expandir un detalle (tooltip o sección desplegable, tema
oscuro) que muestre, por ejecución:
- **Modelo utilizado**
- **Tokens de entrada** / **Tokens de salida**
- **Costo de entrada** / **Costo de salida**
- **Costo total**

Pasos:
- **Schema Prisma** (`CodexRunMetric`): agregar `model String?`,
  `costInputUsd Float @default(0)`, `costOutputUsd Float @default(0)`.
  Crear migración nueva en `backend/prisma/migrations/` (seguir el patrón
  `2026MMDDHHMMSS_add_codex_run_metric_cost_breakdown`). Regenerar el cliente
  (`npm run build:backend` / `npx prisma generate`).
- **Acumulador** (`run-metrics.js`): registrar el `model` del primer/último
  `recordLlmUsage` (o el predominante) e incluir `model`, `costInputUsd`,
  `costOutputUsd` en `metric`. El `model` ya viene en `extractUsage()`; asegurar
  que `agent-loop.js` lo pase al `recordLlmUsage`.
- **Tipo** (`lib/codex/codex-api.ts`): extender `CodexRunMetric` con
  `model: string | null`, `costInputUsd: number`, `costOutputUsd: number`.
- **UI** (`run-summary-card.tsx`): añadir un disclosure secundario en la fila
  Agent Usage (botón/expander o `title`/tooltip) que liste modelo, tokens i/o y
  costos i/o + total con `formatUsd`. Reusar estilos del card (bordes
  `border-white/10`, `text-zinc-*`). No romper el colapso principal existente.

### Brecha C — Acumulado durante toda la sesión del agente (requisito #9)
El `CodexRunMetric` es por-run. Falta el **costo acumulado de la sesión**
(suma de todos los runs del proyecto/sesión activa).

- Calcular el acumulado de sesión sumando `costAppliedUsd` (y total de tokens)
  de los runs de la misma sesión/proyecto. Dos opciones — elegir la más simple
  que respete el alcance:
  1. **Frontend-only (preferida si la sesión = vida del panel):** acumular en el
     estado del panel (`lib/codex/use-codex-run.ts` / `timeline-reducer.ts` o el
     contenedor `codex-agent-panel.tsx`) sumando cada `run_summary` recibido.
  2. **Backend:** endpoint `GET /api/codex/projects/:id/usage` que sume
     `codexRunMetric` por proyecto (respetando ownership con `run-access.js`).
- Mostrar el acumulado en el panel claramente diferenciado del costo del run
  actual (p. ej. "Esta ejecución: $X · Sesión: $Y"). Tema oscuro, `formatUsd`.

---

## Requisitos (mapa de verificación)

| # | Requisito | Estado | Acción |
|---|-----------|--------|--------|
| 1 | Costo total | ✅ existe | — |
| 2 | Costo input/output por separado | ❌ | Brecha A |
| 3 | Usar métricas de uso del proveedor | ✅ existe | — |
| 4 | Fallback a tabla de precios | ✅ existe | — |
| 5 | Sección "Agent Usage" | ✅ existe | — |
| 6 | Tema oscuro | ✅ existe | mantener |
| 7 | Formato monetario `$0.00` | ✅ `formatUsd` | mantener |
| 8 | Actualizar tras cada ejecución | ✅ evento `run_summary` | mantener |
| 9 | Acumular durante toda la sesión | ❌ | Brecha C |
| 10 | Detalle expandible (modelo, tokens i/o, costos i/o, total) | ❌ | Brecha B |

---

## Restricciones

- **No** modificar UI/componentes fuera de `components/codex/**`.
- **No** romper los tests existentes de `backend/tests/codex-*.test.js` ni
  `tests/lib/codex/*` ni `tests/components/codex-*`.
- Mantener todo determinista y offline-testeable (inyectar `fetchImpl`,
  `clock`, etc., como ya hace el código).
- El costo aplicado nunca debe superar el original (`applyPlanPricing` ya lo
  garantiza); preservar esa invariante para los nuevos campos i/o.
- Proveedores gratuitos (Cerebras/FlashGPT) → costo 0 exacto, no "estimado".

## Tests a agregar / actualizar

- `backend/tests/codex-cost-resolver.test.js` — desglose input/output para cada
  rung de la escalera (provider_exact con y sin desglose, openrouter con
  `prompt_cost`/`completion_cost` y sin ellos, estimated, free provider → 0).
- `backend/tests/codex-run-metrics.test.js` — `finalize()` acumula
  `costInputUsd`/`costOutputUsd`, persiste `model`, aplica el multiplicador de
  plan a los nuevos campos.
- `backend/tests/codex-pricing-policy.test.js` — multiplicador aplicado a i/o.
- `tests/lib/codex/*` (vitest, **`--pool=threads`**) — render del detalle
  expandible y del acumulado de sesión en `run-summary-card`.
- Migración: verificar `npx prisma validate` y que el upsert no rompa runs
  antiguos (campos con `@default`).

## Definición de "hecho"

- El panel del run muestra: Time worked, Work done, Items read, Code changed,
  **Agent Usage** (aplicado + original tachado + badge), y un **detalle
  expandible** con modelo, tokens i/o, costo i/o y total.
- Se ve el **acumulado de la sesión** además del costo del run.
- `npm test` y `npm run lint` verdes; migración aplicada; sin cambios fuera del
  alcance Codex.
