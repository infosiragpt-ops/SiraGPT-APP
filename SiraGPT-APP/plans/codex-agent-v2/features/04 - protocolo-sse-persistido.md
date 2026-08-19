# Feature 04 — Protocolo SSE tipado y persistido

**Fase:** F2 · **Depende de:** 01 · **Spec:** `docs/codex-agent-ux.md` §5

## Descripción

El contrato de eventos que hace posible la promesa central del producto: **recargar la página reconstruye el timeline completo**. Cada evento de una corrida se persiste append-only en `codex_events` (seq monotónico) y se publica por Redis pub/sub; la ruta SSE hace replay desde DB y engancha el canal vivo. Mismo patrón probado de `GoalRunEvent` + `blockIndex/seq` del agent-harness (ver `docs/sse-resumption.md`).

## Requisitos

1. **Catálogo de eventos** (módulo `backend/src/services/codex/event-types.js`, única fuente de verdad; sobre común `{ runId, seq, ts, type, data }`):
   - `run_status { status }` · `plan_proposed { architecture, pages[], components[], tasks[] }`
   - `reasoning_start { blockId, label }` · `reasoning_delta { blockId, text }` · `reasoning_end { blockId, durationMs }`
   - `action_start { actionId, kind, command?, path?, groupId }` · `action_end { actionId, status, outputSummary, durationMs, linesRead? }`
   - `narrative_delta { text }` · `checkpoint_created { checkpointId, commitSha, title, createdAt }`
   - `run_summary { metrics }` · `action_required { patternId, title, rawError, blockedCapabilities[], remediationUrl }`
   - `heartbeat {}` (solo wire, **no se persiste**).
   Validador `isValidEvent(type, data)` con tests por tipo.
2. **Event store** (`codex/event-store.js`): `appendEvent(runId, type, data)` asigna `seq` (contador en memoria por run inicializado de `MAX(seq)`, con retry ante colisión del unique `(runId, seq)`), inserta en `codex_events` y publica en Redis canal `codex:run:<runId>`. `listEvents(runId, { afterSeq })` para replay. Los deltas (`narrative_delta`, `reasoning_delta`) pueden coalescerse en lotes de persistencia (cap por tamaño) siempre que el orden por seq se preserve — decidir en el plan TDD de la fase y documentarlo.
3. **Ruta de stream:** `GET /api/codex/runs/:id/stream?afterSeq=N` (auth + ownership vía run→project→userId): headers SSE estándar del repo, replay desde DB de `seq > N`, luego suscripción Redis; heartbeat cada 25s; cleanup de la suscripción en `close`. Corrida terminal sin suscriptor pendiente → replay + evento final + end.
4. **Sin pérdidas ni duplicados:** el cliente reconecta con el último `seq` visto; los eventos publicados entre replay y suscripción no pueden perderse (suscribirse ANTES del replay y bufferear, o re-leer DB tras suscribir — decidir y testear).
5. **Redis:** reutilizar la conexión/utilidades existentes del backend (las mismas que usa BullMQ); con Redis caído el append a DB no falla (publish best-effort, log warn).

## Pasos técnicos

1. `event-types.js` con catálogo + validador (TDD: un test por tipo + rechazo de tipos desconocidos).
2. `event-store.js` con `appendEvent`/`listEvents` (TDD con Prisma falso: seq monotónico, retry de colisión, publish llamado con el canal correcto, Redis caído no rompe).
3. Ruta stream en `routes/codex.js` (contract test con res SSE falso/supertest: replay afterSeq, ownership 404, headers correctos).
4. Test de integración de orden: N appends concurrentes → seqs 1..N sin huecos ni duplicados.
5. Registro de tests, gates, commit y push por paso (formato del plan F1).

## Criterios de aceptación

- [ ] Cada tipo de evento del spec §5 tiene validador y test; un tipo desconocido se rechaza en `appendEvent`.
- [ ] Replay con `afterSeq=0` devuelve el timeline completo en orden; con `afterSeq=k` devuelve exactamente los posteriores.
- [ ] Reconexión simulada (replay + canal vivo con eventos cruzados) no pierde ni duplica seqs.
- [ ] Redis caído: la corrida sigue persistiendo eventos (solo se pierde el live, el replay queda íntegro).
- [ ] Ownership: un usuario no puede abrir el stream de una corrida ajena (404).
- [ ] Suite completa + lint + CI verdes.
