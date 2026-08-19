# Feature 11 — UI: tarjetas y aprobación de plan

**Fase:** F4 · **Depende de:** 07, 08, 09, 10 · **Spec:** `docs/codex-agent-ux.md` §2.1 (puntos 3, 5, 6)

## Descripción

Las cuatro tarjetas que cierran el ciclo de la corrida dentro del timeline (feature 10): el **plan aprobable**, **"Checkpoint made X ago"** con sus tres acciones funcionales, **"Worked for N minutes"** con las métricas reales, y **"Acción requerida de su parte 🔴"**. Todas colapsables, todas alimentadas por los eventos/endpoints reales — cero datos inventados.

## Requisitos

1. **Tarjeta de plan** (`components/codex/plan-card.tsx`, item `plan` del reducer): renderiza arquitectura, páginas, componentes y tareas del `plan_proposed`. Acciones: **Aprobar y construir** → `POST /api/codex/runs { mode:'build', planRunId }`; **Ajustar** → enfoca el composer con un placeholder de feedback (la siguiente corrida `plan` lleva el ajuste). Estado `waiting_approval` visible; tras aprobar, la tarjeta queda colapsada con check.
2. **Tarjeta checkpoint** (`components/codex/checkpoint-card.tsx`, item `checkpoint`): título estilo commit, sha corto, "made X ago" con tiempo relativo (actualizado en vivo, i18n). Acciones:
   - **Rollback here** → diálogo de confirmación explícito (qué se pierde: cambios posteriores al commit) → `POST /api/codex/checkpoints/:id/rollback` → toast de resultado + el timeline anota el rollback.
   - **Changes** → panel/modal con el diff de `GET /api/codex/checkpoints/:id/diff` renderizado con `components/code/diff-view.tsx` (+ shortstat `+a −d`).
   - **View preview** → abre `previewUrl` del proyecto (nueva pestaña); si el dev server no corre, dispara `preview/start` y muestra el estado de arranque (patrón de polling existente del ▶ Ejecutar).
3. **Tarjeta worked-for** (`components/codex/run-summary-card.tsx`, item `summary`): "Worked for N minutes" (formato humanizado de `timeWorkedMs`), y las cinco métricas: Time worked, Work done (`actionsCount` acciones), Items read (`itemsReadLines` líneas), Code changed (`+additions −deletions`), Agent Usage (costo: `costOriginalUsd` **tachado** solo cuando difiere de `costAppliedUsd`; badge "estimado" cuando `costSource === 'estimated'`). Colapsable a una línea.
4. **Tarjeta acción-requerida** (`components/codex/action-required-card.tsx`, item `action_required`): encabezado "Acción requerida de su parte 🔴", error crudo en bloque de código **copiable** (botón copiar con feedback), lista de capacidades bloqueadas, botón/enlace de remediación (`remediationUrl`). No colapsada por defecto (es bloqueante).
5. **Estados y errores de las acciones:** cada acción de tarjeta maneja loading/error (rollback fallido → toast con el mensaje del backend, sin estado inconsistente en la UI).
6. **Hidratación:** las tarjetas se reconstruyen del replay igual que el resto del timeline (items del reducer, feature 10) — recargar después de una corrida terminada muestra las tarjetas completas.

## Pasos técnicos

1. Extender el reducer (feature 10) si hiciera falta metadata adicional por item (p. ej. checkpointId) — con tests.
2. Métodos API en `lib/api.ts` (o `lib/codex/api.ts`): `approvePlan`, `rollbackCheckpoint`, `getCheckpointDiff`, `startPreview` — tipados, con el patrón Bearer existente.
3. Los 4 componentes de tarjeta + tests vitest de render por estado (proposed/approved; checkpoint con/sin acciones en vuelo; summary con/sin tachado y con badge estimado; action-required con copy).
4. Diálogo de confirmación de rollback reutilizando el patrón de diálogos del repo (shadcn/ui existente).
5. Verificación manual del flujo completo contra el backend real (corrida con LLM falso vía env de test o proyecto demo).
6. Gates + commits + push.

## Criterios de aceptación

- [ ] Aprobar el plan crea la corrida build (verificable en red) y la tarjeta pasa a estado aprobado.
- [ ] Rollback exige confirmación, llama al endpoint y refleja el resultado; cancelar el diálogo no llama nada.
- [ ] Changes muestra el diff real con shortstat; View preview abre la URL viva (arrancando el dev server si hace falta).
- [ ] El tachado de precio solo aparece cuando original ≠ aplicado; "estimado" solo cuando el source lo es.
- [ ] El botón copiar copia el rawError completo.
- [ ] Recarga post-corrida: las 4 tarjetas se reconstruyen del replay.
- [ ] vitest + tsc + lint + suite completa verdes.
