# Benchmark de capacidades del motor — SiraGPT

Versión del rubric: **3H60** (2026-08-23, ola 15:57 Lima).  
Alcance: **solo motor** (agent loop, tools, SSE, contexto, checkpoints, créditos). UI sin cambios.

Comparación de referencia: Claude Code / Cowork en el *motor*, no en chrome. Cada fila defiende un cambio medible. `unmeasured` incluye cómo medirla en la siguiente ola.

| Capacidad | Métrica | Actual (3H60) | Target | Cómo medir |
|---|---|---|---|---|
| Multi-step loop sin intervención humana | `stoppedReason` ∈ {final, loop_oscillation_cut, loop_fingerprint_cut, max_iterations, loop_stall}; 0 prompts extra | **parcial / medido en tests** — `runAgentLoop` corre hasta 25 iteraciones; 3H60 corta A-B-A-B (`3H60-Q-001`) | 0 stalls silenciosos; corte < 4 oscilaciones | `node --test tests/ola-3h60-invariants.test.js tests/agent-runner.test.js` |
| Tool-call schema estricto + repair | % llamadas reparadas vs drop; 400 nunca retry | **medido (unit)** — coerce tipos, unwrap vallas/`+`, enum más cercano, refuse nameless | 100 % args inválidos reparados o clasificados; 0 4xx retried | `3H60-A-001` / `3H60-P-001` |
| Retry/backoff transitorio | delayMs determinista; cap 4 | **medido (unit)** — 503/429/timeout retry; 400 no | p95 retry ≤ 3.2 s; 0 retry en 4xx duro | `3H60-B-001` + logs `tool_transient_retry` |
| Tolerancia partial/malformed | hold/drop de chunks incompletos | **heredado 3H59** (hold 8 chunks) + unwrap 3H60 | 0 JSON parcial ejecutado | `ola-3h59` C + `ola-3h60` A |
| Planning + subtasks + step budget | steps heredados = parent−1, cap 12 | **medido (unit)** — inherit + refuse si padre=0 | 0 subagentes con budget 0 | `3H60-C-001` |
| Anti-loop max_steps / huella / oscilación | cut en 3 huellas idénticas (3H59) o 4 A-B (3H60) | **medido (loop)** — fingerprint + oscillation | 0 bucles > 4 pasos idénticos | `3H60-Q-001`, `3H59-G-001` |
| Compactación fiel | resumen de turnos drop + last user + pins | **medido (unit)** + wiring loop si `messages.length > 24` | 0 pérdida del último user; resumen ≤ 720 chars | `3H60-D-001` |
| Relevance prune | Jaccard vs query; keepLast=4 | **medido (unit)** | prune solo overlap < 0.12 | `3H60-D-001` |
| Memory recovery (pgvector pins) | facts `pin`/`score≥0.85` restaurados | **medido (unit)** — no hit live pgvector | 100 % pins recuperados post-compact | `3H60-D-001`; live: `retrieve_memory` + compact |
| Checkpoints + rollback real | snapshot bytes + restore | **medido (unit)** | rollback restaura sha256 | `3H60-E-001` |
| Edit exact-diff + RAW + syntax revert | ---/+++ required; hash post-write; revert unbalance | **medido (unit)** | 0 write inválido persistido | `3H60-E-001` |
| Sandbox stdout/stderr + timeout + cleanup | cap 64 KiB; SIGTERM+SIGKILL on abort | **medido (unit)** + wired en `local-sandbox` | 0 workdir huérfano post-abort | `3H60-F-001` + sandbox tests |
| SSE heartbeat | comment `: heartbeat` **sin** bump de seq | **medido (unit)** + wired `sse-writer.comment` | 0 seq increment en heartbeat | `3H60-G-001` |
| SSE reconnect resume | replay events con seq > Last-Event-ID | **medido (unit)** + wired createSSEWriter | 0 re-exec del turno | `3H60-G-001` |
| SSE cancel AbortController | abort + drop buffer + clear heartbeat | **medido (unit)** + wired done/close | 0 timers/listeners post-cancel | `3H60-G-001` + 3H59 L |
| Cola por sesión + orden estricto | single-writer; gap detect | **medido (unit)** + wired queue.js | 1 writer; wait en hueco | `3H60-H-001` |
| Créditos exactos en cancel/error | settle usage real; never charge pre-token; cap prompt 8192 | **medido (unit)** + wired loop/gateway | 0 cargo si 0 tokens; 0 double settle | `3H60-I-001` |
| Errores clasificados ES | message ES; 0 stacks; 0 `sk-` | **medido (unit)** + public-stream-error | 0 stacks en payload público | `3H60-J-001` / `3H60-N-001` |
| Latencia p50/p95 first-token y end-of-turn | histogram scripted (nunca Flash inventado) | **medido (unit)** — ring 256 | p50/p95 reales bajo carga VPS | `3H60-K-001`; live: `adapterLatencySnapshot()` |
| DeepSeek only | refuse OpenRouter env/model | **medido** | 0 generate OpenRouter | `3H60-J-001` / `3H60-O-001` |

## Cómo correr el rubric

```bash
cd backend
node --test tests/ola-3h60-invariants.test.js tests/ola-3h59-invariants.test.js
node --test tests/sse-writer.test.js tests/public-stream-error.test.js tests/sandbox-local-and-router.test.js
```

Carga real (p50/p95 first-token / end-of-turn): aún **unmeasured en VPS**. Instrumento: `observeScriptedLatencySample` + `adapterLatencySnapshot()`. Recolectar ≥ 200 muestras de generate DeepSeek Flash/Pro, cancel y error.

## Lo que esta ola (3H60) mueve

32 helpers nuevos (no colisionan con 3H59). Wiring fail-open en `loop.js`, `sse-writer.js`, `agent-gateway/queue.js`, `engine-gateway.js`, `local-sandbox.js`, `engine-adapter.js`.

## Queda para la siguiente ola

- p50/p95 first-token y end-of-turn **bajo carga VPS** (hoy solo ring scripted).
- Recuperación pgvector *live* (hoy helper + hits inyectados).
- Rollback de checkpoint a disco/git (hoy snapshot de bytes + restore callback).
- Reconnect SSE e2e con EventSource real + Last-Event-ID persistido en cookie/header.
- Accounting de créditos contra ledger Prisma en el path de error (hoy settle helper + gateway hook).
