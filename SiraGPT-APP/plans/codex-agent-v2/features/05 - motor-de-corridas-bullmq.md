# Feature 05 — Motor de corridas BullMQ

**Fase:** F2 · **Depende de:** 01, 04 · **Spec:** `docs/codex-agent-ux.md` §3, §7

## Descripción

Las corridas dejan de ser un fetch del navegador: cada una es un job de la cola `codex-runs` (BullMQ ya instalado: `bullmq@5.76.10` + bull-board) procesado por un worker en el backend. El ciclo de vida completo queda persistido en `codex_runs` y narrado vía eventos (feature 04). Referencia interna: el patrón cola+ruta+recovery de `/api/goals` (`backend/src/routes/goals.js`, `services/goal-queue.js`, `goal-boot-recovery.js`).

## Requisitos

1. **Cola y worker** (`backend/src/services/codex/run-queue.js`): cola `codex-runs` sobre la conexión Redis existente; worker con concurrencia `CODEX_WORKER_CONCURRENCY` (default 2) y timeout duro por job `CODEX_RUN_TIMEOUT_MS` (default 15 min → corrida `error` con evento `action_required` si aplica patrón, o `run_status error`). El worker **solo se registra si el flag está encendido**. Visible en bull-board.
2. **Creación de corridas:** `POST /api/codex/runs { projectId, mode, prompt, model?, tier?, planRunId? }` (auth + ownership del proyecto) → fila `queued` + enqueue (jobId persistido) → 201 con proyección pública. Validaciones: `mode ∈ {plan, build}`; `build` exige `planRunId` de una corrida `plan` del mismo proyecto en estado `waiting_approval`/`done`; un solo run activo (`queued|running|waiting_approval`) por proyecto → 409 `run_in_progress`.
3. **Ciclo de vida:** transiciones `queued → running → (waiting_approval | done | error | cancelled)` persistidas con timestamps (`startedAt`/`finishedAt`) y siempre acompañadas de evento `run_status`. El handler del job delega en el loop del agente (feature 06) y captura cualquier excepción → `error` + evento.
4. **Cancelación:** `POST /api/codex/runs/:id/cancel` → marca `cancelled`, remueve/señala el job (señal de abort cooperativa que el loop consulta entre pasos), evento `run_status cancelled`. Cancelar una corrida terminal → 409.
5. **Recovery al boot:** al iniciar el backend con flag on, corridas `running`/`queued` cuyo job ya no existe en la cola → `error` con mensaje "interrumpida por reinicio" (patrón `goal-boot-recovery`).
6. **Lectura:** `GET /api/codex/runs/:id` (proyección con status/mode/timestamps/métrica si existe) y `GET /api/codex/projects/:id/runs` (lista paginada por createdAt desc).

## Pasos técnicos

1. `run-queue.js`: factoría de cola/worker inyectable (Redis falso o `bullmq` con `connection` mockeada en tests; el handler de job se testea como función pura).
2. `run-service.js`: createRun (validaciones + enqueue), cancelRun, getRun/listRuns con ownership — TDD con DB falsa y cola falsa.
3. Rutas en `routes/codex.js` (contract tests: validación de mode/planRunId, 409 run activo, cancel, ownership).
4. Registro del worker en `backend/index.js` condicionado al flag; recovery al boot con tests (corridas huérfanas marcadas).
5. Gates + commits + push (formato plan F1).

## Criterios de aceptación

- [ ] Crear corrida encola un job real y persiste `jobId`; el ciclo de vida queda en DB con sus eventos `run_status` en orden.
- [ ] Segundo run sobre el mismo proyecto con uno activo → 409.
- [ ] `build` sin `planRunId` válido → 400.
- [ ] Cancel a mitad de corrida detiene el loop en el siguiente paso y deja `cancelled` + evento.
- [ ] Timeout duro convierte la corrida en `error` (sin job zombie).
- [ ] Reinicio del backend con corridas en vuelo → recovery las marca `error`; ninguna queda `running` eterna.
- [ ] Flag off: el worker no se registra y las rutas devuelven 404.
- [ ] Suite completa + lint + CI verdes.
