# Feature 08 — Métricas y costos multi-proveedor

**Fase:** F3 · **Depende de:** 05, 06 · **Spec:** `docs/codex-agent-ux.md` §7 (costos), §4 (`CodexRunMetric`)

## Descripción

Los números reales detrás de la tarjeta "Worked for N minutes": Time worked, Work done (acciones), Items read (líneas), Code changed (±diffstat) y Agent Usage (costo con precio original tachado → precio aplicado). Nada inventado: cronómetro del job, contadores del loop, `git diff --shortstat` y el usage que devuelve cada proveedor.

## Requisitos

1. **Acumulador por corrida** (`codex/run-metrics.js`): objeto mutable que el loop alimenta — `recordAction(kind, durationMs)`, `recordLinesRead(n)`, `recordLlmUsage({ tokensIn, tokensOut, provider, model, generationId? })`. Al cierre: `timeWorkedMs` = finishedAt − startedAt del job (reloj inyectable), diffstat del checkpoint (feature 07, `{ additions, deletions }`; sin checkpoint → 0/0). Persiste `CodexRunMetric` (upsert por `runId`) y emite `run_summary { metrics }`.
2. **Escalera de costo** (`codex/cost-resolver.js`), en orden, con `costSource` explícito:
   - `provider_exact`: el response del proveedor trae `usage` con costo directo o tokens + tarifa conocida del proveedor (con `include_usage` activado en cada llamada).
   - `openrouter_generation`: si el proveedor es OpenRouter y hay `generationId`, GET `/api/v1/generation?id=` (con `OPENROUTER_API_KEY`) → costo nativo. Fallo de la consulta → degradar al siguiente escalón, jamás romper la corrida.
   - `estimated`: `estimateCostUsd(provider, tokens)` del agent-harness (`backend/src/services/agent-harness/event-stream.js`); proveedor sin tarifa (p. ej. Cerebras/FlashGPT) → costo 0 exacto con source `provider_exact`.
3. **Precio tachado → aplicado:** `costOriginalUsd` = tarifa de lista acumulada; `costAppliedUsd` = tras multiplicador de plan (`codex/pricing-policy.js`, lee el plan del usuario del catálogo existente `plan-credits-catalog`; FREE/modelos gratis → 0). La tarjeta muestra ambos; si son iguales no hay tachado (decisión de UI, feature 11).
4. **Conteo honesto:** `actionsCount` = acciones con `action_end` (cualquier status); `itemsReadLines` = suma de `linesRead` de los `read_file`; los caps/truncados no inflan los números.
5. **Lectura:** la métrica viaja dentro de `GET /api/codex/runs/:id` y en el evento `run_summary` (mismo shape `CodexRunMetric`, proyección pública).

## Pasos técnicos

1. `run-metrics.js` TDD: acumulación, upsert, `run_summary` emitido con el shape exacto, reloj inyectable.
2. `cost-resolver.js` TDD con fetch mockeado: matriz proveedor × disponibilidad de usage → source correcto; OpenRouter con/sin key, con `/generation` OK/fallando; Cerebras → 0.
3. `pricing-policy.js` TDD: multiplicadores por plan, redondeos (centavos), original vs aplicado.
4. Integración en el cierre del loop (feature 06) y del job (feature 05): orden checkpoint → diffstat → métrica → `run_summary` → `run_status done`.
5. Gates + commits + push.

## Criterios de aceptación

- [ ] Una corrida con LLM falso (usage conocido) y 5 acciones produce una `CodexRunMetric` con números exactos verificados campo a campo.
- [ ] Matriz de costo: provider con usage → `provider_exact`; OpenRouter+generationId+key → `openrouter_generation`; sin datos → `estimated`; Cerebras → 0.
- [ ] Caída de `/api/v1/generation` degrada el source sin afectar el estado de la corrida.
- [ ] `costOriginalUsd ≥ costAppliedUsd` siempre; plan FREE con modelo gratis → ambos 0.
- [ ] `run_summary` es el penúltimo evento (antes del `run_status` terminal) y su shape valida contra `event-types.js`.
- [ ] Suite completa + lint + CI verdes.
