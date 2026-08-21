# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H44** (2026-08-21 12:57 America/Lima, 2026-08-21T17:57Z). Superpone 3H43 + per-session inflight tools max 8 / leftover // line comments in tool JSON / reject NaN-Infinity numbers / drop SSE events older than 2 min / compact summary cap 2KiB / refuse write to /etc /proc /sys / never negative usage / queue fair-share extra slot if wait >20s / skip memory if score NaN / cancel if 3 stream stalls / strip bidi override chars / tool name charset [A-Za-z0-9_.-] / cycle detect A→B→A / max plan steps 24 / refuse checkpoint >1MiB uncompressed / reject Last-Event-ID going backwards / glob max 32 matches / redact JWT-shaped strings / refuse computer_* without userId / min remaining subagent budget 1 / drop incomplete trailing tool call / never retry 413 / per-line stdout 8KiB / close if client gone 30s / session lock ttl 90s / Redis ECONNREFUSED retryable / hard cap tool timeout 120s / flush last SSE event before close / max 8KB serialized tool list / screenshot-only no-charge.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo; 0 x 402 Insufficient Balance desde StartedAt 3H43 `2026-08-21T15:25:29Z`). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h44-invariants.test.js` + `tests/ola-3h43-invariants.test.js` + `tests/ola-3h42-invariants.test.js` (wave 3H42|3H43|3H44). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H43) | Despues (3H44) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | inherit remaining + skip completed + stall 20s | **cancel if 3 stalls** + **plan steps 24** + **min remaining 1** | stream_stall_cancel; plan_steps_cap; subagent_min |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | 32KiB args + newline JSON + null coerce + name 64 + same-name >8 | **inflight 8** + **// line comments** + **NaN/Infinity reject** + **charset** + **A→B→A cycle** + **drop incomplete trailing** + **tool list 8KB** | inflight_tools; json_line_comment; nan_infinity; tool_name_charset; tool_cycle |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | skip completed on resume | **max 24 plan steps** | plan_steps_cap |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | pins + last 3 users + embedding dim | **summary 2KiB** + **skip NaN score** | compact_summary; memory_score_nan |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | gzip >64KiB + Last-Event-ID int + lock pid | **refuse ckpt >1MiB uncompressed** + **id no backwards** + **lock ttl 90s** | ckpt_too_large; sse_id_backwards; lock_ttl |
| 6 | File edit exact diff + verify | unique hunk + scheduler | dest dir missing + homoglyph + glob 1MiB | **refuse /etc /proc /sys** + **glob 32 matches** + **bidi strip** | path_system; glob_match_cap; bidi_strip |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | combined 96KiB + default 30s | **per-line 8KiB** + **hard cap 120s** | line_cap; tool_timeout_cap |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | 16 buffers + ping >15s + int-only id | **drop events >2 min** + **client gone 30s** + **flush last event** | sse_stale; client_gone; sse_flush |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | wait 60s then 503 | **fair-share extra slot if wait >20s** | queue_fair_share |
| 10 | Credit/token accounting on cancel | hold + settle + release | ceil tokens + close SSE then settle | **never negative usage** + **screenshot-only no-charge** | usage_negative; credit_screenshot |
| 11 | Classified errors | code publico ES | ECONNRESET cancelled + never 402 + Prisma | **never retry 413** + **Redis ECONNREFUSED** + **JWT redact** + **computer_* no userId** | payload_too_large; redis_disconnect; jwt_redact; computer_no_user |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | stall 20s + wave 3H43 | **3 stalls cancel** + **wave 3H44** | stream_stall_cancel; health 3H44; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H44 mueve caps 1-12 (30 helpers nuevos; 3H43 intacto). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H44 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- ETIMEDOUT ya se clasifica timeout en `classifyHttpFamily`/`classifyNetErrors`. `rejectNulInPath` ya existia (3H41). `circuitBreakerEmptyModelTwice` / `stripAdditionalProperties` / subagent depth 2 / concurrent subagents 2 ya existian.

## 3H44 live (21-ago 12:57 Lima)

Codigo 3H44 shipped. Tests: `ola-3h44-invariants.test.js` + `ola-3h43-invariants.test.js` + `ola-3h42-invariants.test.js` (wave acepta 3H44). TTFB live unmeasured (no se llamo DeepSeek en smoke largo). 0 x 402 reales desde 15:25Z. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25).

## 3H43 live (21-ago 09:57 Lima)

Queda en `ola-3h-20260821-0957.md`.

## 3H42 live (21-ago 06:57 Lima)

Queda en `ola-3h-20260821-0657.md`.
