# Benchmark de capacidades del motor — SiraGPT

Versión del rubric: **3H63** (2026-08-24) sobre **3H62** + **hot path #388 / #399**.  
Alcance: **solo motor** (agent loop, tools, SSE, contexto, checkpoints, créditos). UI sin cambios.

Comparación de referencia: Claude Code / Cowork en el *motor*, no en chrome. Cada fila defiende un cambio medible. `unmeasured` incluye cómo medirla en la siguiente ola.

| Capacidad | Métrica | Actual (3H63) | Target | Cómo medir |
|---|---|---|---|---|
| Multi-step loop sin intervención humana | `stoppedReason` ∈ {final, loop_oscillation_cut, loop_fingerprint_cut, max_iterations, loop_stall}; 0 prompts extra | **parcial / medido en tests** — `runAgentLoop` corre hasta 25 iteraciones; 3H60 corta A-B-A-B (`3H60-Q-001`) | 0 stalls silenciosos; corte < 4 oscilaciones | `node --test tests/ola-3h60-invariants.test.js tests/agent-runner.test.js` |
| Tool-call schema estricto + repair | % llamadas reparadas vs drop; 400 nunca retry | **medido (unit)** — coerce tipos, unwrap vallas/`+`, enum más cercano, refuse nameless | 100 % args inválidos reparados o clasificados; 0 4xx retried | `3H60-A-001` / `3H60-P-001` |
| Retry/backoff transitorio | delayMs determinista; cap 4 | **medido (unit)** — 503/429/timeout retry; 400 no | p95 retry ≤ 3.2 s; 0 retry en 4xx duro | `3H60-B-001` + logs `tool_transient_retry` |
| Tolerancia partial/malformed | hold/drop de chunks incompletos | **fail-closed** — `concatenateSplitToolCallFragments` + `dropIncompleteTrailingToolCall` + repair JSON across chunks / newlines before execute | 0 JSON parcial ejecutado | `3H63-F-001` / `3H63-L-001` |
| Planning + subtasks + step budget | steps heredados = parent−1, cap 12 | **fail-closed** — inherit + `minRemainingSubagentBudget1` + refuse si padre=0; abort nested/siblings on parent halt | 0 subagentes con budget 0 | `3H63-D-001` / `3H63-E-001` / `3H63-M-001` |
| Anti-loop max_steps / huella / oscilación | cut en 3 huellas idénticas, 4 A-B, o 3 idle sin artefacto | **fail-closed** — fingerprint + oscillation + `cutSubtaskIfNoProgress` | 0 bucles > 4 pasos idénticos; 0 subtask idle ≥ 3 | `3H61-K-001` / `3H61-M-001` |
| Compactación fiel | resumen de turnos drop + last user + pins | **medido (unit)** + wiring loop si `messages.length > 24` | 0 pérdida del último user; resumen ≤ 720 chars | `3H60-D-001` |
| Relevance prune | Jaccard vs query; keepLast=4 | **medido (unit)** | prune solo overlap < 0.12 | `3H60-D-001` |
| Memory recovery (pgvector pins) | facts `pin`/`score≥0.85` restaurados | **fail-closed** — `retrieveMemoryBeforeGenerateClosed` (2s + inf-reject + min-score) + `recoverPgvectorPinsClosed` en compact | 100 % pins recuperados post-compact; generate sin memoria si timeout | `3H62-H-001` / `3H62-V-001`; live: `retrieveMemoryForLoop` + compact |
| Checkpoints + rollback real | snapshot bytes + restore on timeout/fail | **fail-closed** — 3H61 timeout rollback + 3H62 session persist/hydrate across restart | rollback restaura bytes previos; session ckpt sobrevive process restart | `3H61-B-001` / `3H62-G-001` / `3H62-M-001` |
| Edit exact-diff + RAW + syntax revert | ---/+++ required; hash post-write; syntax revert; checksum since-read | **fail-closed** — 3H62 RAW/syntax + `refuseEditIfChecksumChangedSinceRead` / `applyUnifiedDiff` / jail / skip-noop | 0 write inválido persistido; uniqueness ≠ timeout/syntax | `3H63-G-001` / `3H63-K-001` + 3H62 B–D |
| Sandbox stdout/stderr + timeout + cleanup | cap 64 KiB; cleanup + reap huérfanos `sira-sbx-*` | **fail-closed** — `loop.js` llama `sandboxTimeoutThenCleanup` + `sandboxReapOrphanWorkdirs` en timeout/abort; `local-sandbox` apply | 0 workdir huérfano post-timeout | `3H61-E-001` / `3H61-N-001` / `3H61-R-001` |
| SSE heartbeat | comment `: heartbeat` **sin** bump de seq | **medido (unit)** + wired `sse-writer.comment` | 0 seq increment en heartbeat | `3H60-G-001` |
| SSE reconnect resume | replay events; persist Last-Event-ID; reject last > head **and going backwards** | **fail-closed** — 3H62 persist + `rejectLastEventIdGoingBackwards` + last-N replay | 0 re-exec; 0 replay desde seq inválido o hacia atrás | `3H63-H-001` + 3H62 E/T/U |
| SSE cancel AbortController | abort + drop buffer + clear heartbeat | **fail-closed** — generate `sseCancelClearsHeartbeat` + writer done/close | 0 timers/listeners post-cancel | `3H61-J-001` + 3H59 L |
| Cola por sesión + orden estricto | single-writer; gap detect; 503 after 60s; drop duplicate in-flight | **fail-closed** — generate path llama `acquireFairGenerateLock` / `queueMaxWait60sThen503` / `dropDuplicateInFlightGenerate` | 1 writer; 503 si espera ≥ 60 s; 0 duplicate in-flight | `3H63-B-001` / `3H63-C-001` |
| Créditos exactos en cancel/error | settle usage real; Prisma ledger; never double-count; **partial-token refund**; success complete | **fail-closed** — 3H62 fail-ledger + `refundPartialTokensOnCancel` + live `completeLedgerTransaction` on success / cancel-after-tokens | 0 cargo si 0 tokens; 0 double settle; refund hold si cancel pre-completion | `3H63-I-001` / `3H63-R-001` + 3H62 I |
| Errores clasificados ES | message ES; 0 stacks; 0 `sk-` | **fail-closed** — `classifyPublicLoopErrorClosed` en loop/onEvent | 0 stacks en payload público | `3H61-H-001` / `3H61-Q-001` |
| Latencia p50/p95 first-token y end-of-turn | histogram scripted (nunca Flash inventado) | **fail-closed** — `recordFirstTokenLatencySampleP95` + `observeFirstToken` en generate write y loop; over-budget hint; fake timers | p50/p95 reales bajo carga VPS | `3H62-J-001` / `3H62-W-001`; live: `adapterLatencySnapshot()` |
| DeepSeek only | refuse OpenRouter env/model | **medido** | 0 generate OpenRouter | `3H60-J-001` / `3H60-O-001` |

## Cómo correr el rubric

```bash
cd backend
node --test tests/ola-3h63-invariants.test.js tests/ola-3h62-invariants.test.js tests/ola-3h61-invariants.test.js tests/engine-hotpath-wire.test.js
node --test tests/sse-writer.test.js tests/public-stream-error.test.js tests/sandbox-local-and-router.test.js
```

Carga real (p50/p95 first-token / end-of-turn): aún **unmeasured en VPS**. Instrumento: `observeTurnLatencyClosed` + `observeScriptedLatencySample` + `adapterLatencySnapshot()`. Recolectar ≥ 200 muestras de generate DeepSeek Flash/Pro, cancel y error.

## Lo que esta ola (3H63) mueve vs 3H62

3H62 cableó RAW/syntax, Last-Event-ID persistido, checkpoint de sesión, pins y ledger-on-error. 3H63 cierra los helpers que seguían **adapter-only**: **cola/fair generate** (503 a los 60 s, drop duplicate in-flight), **abort cascade + budget parent−1**, **repair de fragments / drop trailing incompleto**, **checksum since-read + jail + unified diff**, **Last-Event-ID hacia atrás**, **refund de tokens parciales**, **watchdog first-byte 45 s**, y **`completeLedgerTransaction` vivo** en success / cancel-after-tokens. Sin nombres overlay que choquen con 3H59–3H62.

## Queda para la siguiente ola

- p50/p95 first-token y end-of-turn **bajo carga VPS** (hoy ring scripted + hooks en loop/generate).
- Reconnect SSE e2e con EventSource real en browser (persist + inclusive replay + reject-backwards ya están en generate).

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
