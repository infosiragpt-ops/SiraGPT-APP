# Benchmark de capacidades del motor — SiraGPT

Versión del rubric: **3H62** (2026-08-24, ola 21:57 Lima) sobre **3H61** + **hot path #388 / #399**.  
Alcance: **solo motor** (agent loop, tools, SSE, contexto, checkpoints, créditos). UI sin cambios.

Comparación de referencia: Claude Code / Cowork en el *motor*, no en chrome. Cada fila defiende un cambio medible. `unmeasured` incluye cómo medirla en la siguiente ola.

| Capacidad | Métrica | Actual (3H62) | Target | Cómo medir |
|---|---|---|---|---|
| Multi-step loop sin intervención humana | `stoppedReason` ∈ {final, loop_oscillation_cut, loop_fingerprint_cut, max_iterations, loop_stall}; 0 prompts extra | **parcial / medido en tests** — `runAgentLoop` corre hasta 25 iteraciones; 3H60 corta A-B-A-B (`3H60-Q-001`) | 0 stalls silenciosos; corte < 4 oscilaciones | `node --test tests/ola-3h60-invariants.test.js tests/agent-runner.test.js` |
| Tool-call schema estricto + repair | % llamadas reparadas vs drop; 400 nunca retry | **medido (unit)** — coerce tipos, unwrap vallas/`+`, enum más cercano, refuse nameless | 100 % args inválidos reparados o clasificados; 0 4xx retried | `3H60-A-001` / `3H60-P-001` |
| Retry/backoff transitorio | delayMs determinista; cap 4 | **medido (unit)** — 503/429/timeout retry; 400 no | p95 retry ≤ 3.2 s; 0 retry en 4xx duro | `3H60-B-001` + logs `tool_transient_retry` |
| Tolerancia partial/malformed | hold/drop de chunks incompletos | **heredado 3H59** (hold 8 chunks) + unwrap 3H60 | 0 JSON parcial ejecutado | `ola-3h59` C + `ola-3h60` A |
| Planning + subtasks + step budget | steps heredados = parent−1, cap 12 | **medido (unit)** — inherit + refuse si padre=0 | 0 subagentes con budget 0 | `3H60-C-001` |
| Anti-loop max_steps / huella / oscilación | cut en 3 huellas idénticas, 4 A-B, o 3 idle sin artefacto | **fail-closed** — fingerprint + oscillation + `cutSubtaskIfNoProgress` | 0 bucles > 4 pasos idénticos; 0 subtask idle ≥ 3 | `3H61-K-001` / `3H61-M-001` |
| Compactación fiel | resumen de turnos drop + last user + pins | **medido (unit)** + wiring loop si `messages.length > 24` | 0 pérdida del último user; resumen ≤ 720 chars | `3H60-D-001` |
| Relevance prune | Jaccard vs query; keepLast=4 | **medido (unit)** | prune solo overlap < 0.12 | `3H60-D-001` |
| Memory recovery (pgvector pins) | facts `pin`/`score≥0.85` restaurados | **fail-closed** — `retrieveMemoryBeforeGenerateClosed` (2s + inf-reject + min-score) + `recoverPgvectorPinsClosed` en compact | 100 % pins recuperados post-compact; generate sin memoria si timeout | `3H62-H-001` / `3H62-V-001`; live: `retrieveMemoryForLoop` + compact |
| Checkpoints + rollback real | snapshot bytes + restore on timeout/fail | **fail-closed** — 3H61 timeout rollback + 3H62 session persist/hydrate across restart | rollback restaura bytes previos; session ckpt sobrevive process restart | `3H61-B-001` / `3H62-G-001` / `3H62-M-001` |
| Edit exact-diff + RAW + syntax revert | ---/+++ required; hash post-write; syntax revert | **fail-closed** — `validateWriteThenRevertClosed` + `requireExactDiffMarkersClosed` in `loop.js` | 0 write inválido persistido; uniqueness ≠ timeout/syntax | `3H62-B-001` / `3H62-C-001` / `3H62-D-001` / `3H62-K-001` / `3H62-L-001` |
| Sandbox stdout/stderr + timeout + cleanup | cap 64 KiB; cleanup + reap huérfanos `sira-sbx-*` | **fail-closed** — `loop.js` llama `sandboxTimeoutThenCleanup` + `sandboxReapOrphanWorkdirs` en timeout/abort; `local-sandbox` apply | 0 workdir huérfano post-timeout | `3H61-E-001` / `3H61-N-001` / `3H61-R-001` |
| SSE heartbeat | comment `: heartbeat` **sin** bump de seq | **medido (unit)** + wired `sse-writer.comment` | 0 seq increment en heartbeat | `3H60-G-001` |
| SSE reconnect resume | replay events; persist Last-Event-ID; reject last > head | **fail-closed** — `persistSseLastEventIdCursor` en write + cookie/header `sira_last_event_id` + file persist; inclusive replay | 0 re-exec; 0 replay desde seq inválido; cursor sobrevive restart | `3H62-E-001` / `3H62-T-001` / `3H62-U-001` |
| SSE cancel AbortController | abort + drop buffer + clear heartbeat | **fail-closed** — generate `sseCancelClearsHeartbeat` + writer done/close | 0 timers/listeners post-cancel | `3H61-J-001` + 3H59 L |
| Cola por sesión + orden estricto | single-writer; gap detect | **medido (unit)** + wired queue.js | 1 writer; wait en hueco | `3H60-H-001` |
| Créditos exactos en cancel/error | settle usage real; Prisma ledger; never double-count | **fail-closed** — `settleLedgerOnErrorClosed` (3H60/3H61 + `failLedgerTransaction`) | 0 cargo si 0 tokens; 0 double settle; ledger fail en error | `3H62-I-001` / loop bail + generate finally |
| Errores clasificados ES | message ES; 0 stacks; 0 `sk-` | **fail-closed** — `classifyPublicLoopErrorClosed` en loop/onEvent | 0 stacks en payload público | `3H61-H-001` / `3H61-Q-001` |
| Latencia p50/p95 first-token y end-of-turn | histogram scripted (nunca Flash inventado) | **fail-closed** — `recordFirstTokenLatencySampleP95` + `observeFirstToken` en generate write y loop; over-budget hint; fake timers | p50/p95 reales bajo carga VPS | `3H62-J-001` / `3H62-W-001`; live: `adapterLatencySnapshot()` |
| DeepSeek only | refuse OpenRouter env/model | **medido** | 0 generate OpenRouter | `3H60-J-001` / `3H60-O-001` |

## Cómo correr el rubric

```bash
cd backend
node --test tests/ola-3h62-invariants.test.js tests/ola-3h61-invariants.test.js tests/ola-3h60-invariants.test.js tests/ola-3h59-invariants.test.js
node --test tests/engine-hotpath-wire.test.js
node --test tests/sse-writer.test.js tests/public-stream-error.test.js tests/sandbox-local-and-router.test.js
```

Carga real (p50/p95 first-token / end-of-turn): aún **unmeasured en VPS**. Instrumento: `observeTurnLatencyClosed` + `observeScriptedLatencySample` + `adapterLatencySnapshot()`. Recolectar ≥ 200 muestras de generate DeepSeek Flash/Pro, cancel y error.

## Lo que esta ola (3H62) mueve vs 3H61

3H61 cableó checkpoint/timeout rollback + SSE leak guards por nombre 3H59. 3H62 cierra los huecos que seguían en unit-only: **RAW + syntax revert** (complementa el rollback por timeout; `str_replace` uniqueness sigue distinto), **Last-Event-ID persistido** para EventSource resume inclusivo, **checkpoint de sesión en disco** (no solo Map), **pins pgvector** en compact/resume, **ledger Prisma** en cancel/error, **p50/p95 first-token y end-of-turn** con fake timers. Sin nombres overlay que choquen con 3H59–3H61.

## Queda para la siguiente ola

- p50/p95 first-token y end-of-turn **bajo carga VPS** (hoy ring scripted + hooks en loop/generate).
- Reconnect SSE e2e con EventSource real en browser (el persist + inclusive replay ya están en generate).
- Completar ledger Prisma con `completeLedgerTransaction` de usage parcial (hoy fail-closed `failLedgerTransaction` + settle helper).

## Hot path #388 / #399

3H60 ya está en `production-main`. Este ship **no** reescribe PRs 381–385 ni sustituye el overlay: cablea los exports **vivos de #388** (`engine-adapter.js` + `engine-3h59.js`) en el hot path, fail-closed.

| Señal | Cómo se mide |
|---|---|
| Wired | `loop.js` / `ai.js` llaman el helper #388 por su nombre exportado |
| Fail-closed | error de herramienta transitoria o repair-fail **detiene** el loop |
| Tests | `backend/tests/engine-hotpath-wire.test.js` + 3H32-S-002 (exclusive default) |

| Capacidad | Target (Claude Code / Cowork) | Medido en vivo (antes) | Medido tras este ship | Helper #388 |
|---|---|---|---|---|
| 1. Tool-call retry / repair | Reintento transitorio (timeout / ECONNRESET / 502) del **mismo** tool; re-invoke tras repair; stop tras N repair-fail | Una pasada `repairPartialToolCallSchema` + `executor(args)` una vez; `catch` → string `ERROR`. `retryToolWithBackoff` / `isRetryableToolFailure` existían en `engine-adapter.js` y **cero callsites** en `loop.js` | `loop.js` llama `retryToolWithBackoff` + `isRetryableToolFailure` (max 3). Tras `__parse_error`, `repairTruncatedJson` y re-invoke. 3 repair-fail consecutivos → `tool_repair_exhausted`. Transient exhaust → `tool_retry_exhausted` (no sigue el loop con strings ERROR). 3H60 `settleCreditsOnError` se conserva en el path ERROR | `retryToolWithBackoff`, `isRetryableToolFailure`, `repairTruncatedJson`, `repairPartialToolCallSchema` |
| 2. Session queue / SSE | Heartbeat en el stream de **generate**; Last-Event-ID replay **inclusivo** si hay ring; flush al cancel; FIFO per-session | Generate in-process; BullMQ default OFF. ChatRun `: ping` 15s **no** es generate. Generate usaba `setInterval` crudo. `honorLastEventId` era exclusivo (`seq > n`). FIFO ya existe en `agent-gateway/queue.js` (`lanes` + `sessionQueueOrderBySeq`) | Generate usa `startCommentHeartbeat`. `honorLastEventId(..., { inclusive: true })` cuando hay ring de chunks. Default del helper sigue exclusivo (3H32-S-002 verde). Cancel/finally llama `stop()`. BullMQ **sigue OFF**. No se aplicó 381–385 | `startCommentHeartbeat`, `honorLastEventId`, `sessionQueueOrderBySeq` |
| 3. Context compaction | Compactar **antes** de `callModel` si pasa presupuesto; conservar system + pins; sin UI `/compact` | `compactUntilTokenBudget` / `anchorCriticalFacts` / `compactPreserveFactAnchors` existían y **cero callsites** en `loop.js` / `index.js` | `compactMessagesInPlace` corre antes de cada `callModel`: `compactUntilTokenBudget` + restore de `anchorCriticalFacts` / `compactPreserveFactAnchors`. 3H60 compact-if-`messages.length > 24` se conserva. Sin ruta `/compact` | `compactUntilTokenBudget`, `estimateCompactTokens`, `anchorCriticalFacts`, `compactPreserveFactAnchors` |

### Notas de no-regresión

- El hot path usa nombres #388 (`retryToolWithBackoff`, `honorLastEventId`, `compactUntilTokenBudget`). Los helpers 3H60 (`retryTransientToolError`, `sseReplayFromLastEventId`, …) **siguen** en el overlay y en el loop fail-open; no se borran.
- `honorLastEventId` sin `{ inclusive: true }` sigue filtrando `seq > n`.
- DeepSeek only. Sin OpenRouter. Sin cambios de UI. Sin `docker compose down -v`.
