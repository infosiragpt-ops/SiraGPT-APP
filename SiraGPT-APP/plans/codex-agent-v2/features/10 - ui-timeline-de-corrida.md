# Feature 10 — UI: timeline de corrida

**Fase:** F4 · **Depende de:** 04, 06 · **Spec:** `docs/codex-agent-ux.md` §2.1, §9

## Descripción

El corazón visual de la experiencia: dentro del layout actual de `/code`, un `CodexRunTimeline` que consume el stream SSE (y el replay al recargar) y renderiza en orden de `seq`: párrafos de narrativa, **filas de chips de acciones agrupadas** con contador "N actions" expandible, **bloques de razonamiento colapsables** con etiqueta y duración («Planning database migration verification (47 seconds)»), y la **píldora flotante "Scroll to latest"**. Evolución directa de `components/agent-trace.tsx` y `components/thinking-trace.tsx` — mismos patrones de shimmer, colapso y conector.

## Requisitos

1. **Reducer puro** (`lib/codex/timeline-reducer.ts`): `(state, event) → state`, testeable sin React. Estado: lista ordenada de items `{ kind: 'narrative'|'reasoning'|'action_group'|'plan'|'checkpoint'|'summary'|'action_required'|'status' }`. Reglas:
   - `narrative_delta` concatena al último item narrative (o abre uno).
   - `reasoning_start/delta/end` arman el bloque con `label` y `durationMs` final.
   - `action_start/end` con el mismo `groupId` se agrupan en una fila (ícono por `kind`: terminal/archivo-lectura/archivo-escritura/razonamiento/web; estados running→done/error).
   - **Dedupe por seq**: un evento con seq ya aplicado se ignora (reconexiones).
   - Eventos de tarjetas (`plan_proposed`, `checkpoint_created`, `run_summary`, `action_required`) crean items que la feature 11 renderiza.
2. **Cliente SSE** (`lib/codex/run-stream.ts`): abre `GET /api/codex/runs/:id/stream?afterSeq=N` con el token Bearer (patrón `lib/api.ts`), parsea el sobre `{ runId, seq, ts, type, data }`, reconecta con backoff usando el último seq visto. Hidratación al montar: replay completo desde `afterSeq=0`.
3. **Componente** (`components/codex/run-timeline.tsx`): render por item; chips con contador "N actions" colapsadas por defecto, expandibles al detalle (comando + outputSummary en `CustomCodeBlock`, tinte rojo en error — patrón `agent-trace.tsx`); razonamiento colapsado al terminar con resumen "etiqueta (Xs)"; estados de carga con el shimmer existente.
4. **Scroll to latest:** auto-scroll pegado al fondo durante streaming; si el usuario sube, aparece la píldora flotante; click → vuelve al fondo y re-engancha el auto-scroll (umbral y comportamiento testeable como hook `useStickToBottom`).
5. **Gating:** la UI V2 solo se monta si `GET /api/codex/health` → `enabled: true` (fetch una vez, cacheado en el provider del workspace). Flag off → `/code` idéntico a hoy, sin requests extra visibles.
6. **Sin tocar flujos existentes:** el chat panel actual no se modifica; el timeline vive en la rama nueva de UI (regla #1 de CLAUDE.md está levantada para esta feature por decisión del propietario, pero el principio de no-regresión se mantiene).

## Pasos técnicos

1. `timeline-reducer.ts` TDD con vitest (`tests/lib/`): un test por tipo de evento + agrupado por groupId + dedupe por seq + orden estable.
2. `run-stream.ts` con EventSource/fetch-stream inyectable: tests de parseo, reconexión con afterSeq, backoff.
3. `useStickToBottom` hook + tests de lógica (umbral, re-enganche).
4. `run-timeline.tsx` + subcomponentes (`action-chips-row.tsx`, `reasoning-block.tsx`) reutilizando iconografía y estilos de `agent-trace.tsx`.
5. Integración en `/code` detrás del health check; verificación manual con una corrida fake (endpoint de seed de eventos solo-dev o fixture replay).
6. Gates (vitest + `npx tsc --noEmit` + lint + suite backend intacta) + commits + push.

## Criterios de aceptación

- [ ] El reducer cubre los 12 tipos de evento del spec §5 con tests; eventos duplicados (mismo seq) no alteran el estado.
- [ ] Recargar la página a mitad de corrida reconstruye el timeline idéntico (replay) y sigue en vivo sin huecos.
- [ ] Chips: 4 acciones consecutivas del mismo groupId → una fila "4 actions"; expandir muestra comando y salida; acción fallida en rojo.
- [ ] Razonamiento muestra etiqueta y duración real al colapsar.
- [ ] La píldora aparece solo cuando el usuario está scrolleado hacia arriba durante streaming y desaparece al volver al fondo.
- [ ] Flag off: `/code` renderiza exactamente como hoy.
- [ ] vitest + tsc + lint + suite completa verdes.
