# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H43** (2026-08-21 09:57 America/Lima, 2026-08-21T14:57Z). Superpone 3H42 + tool arg 32KiB cap with truncate marker / JSON unescaped-newline repair / coerce "null" string only on optional fields / max 16 SSE buffers drop oldest / compact pinned facts + last 3 user turns / refuse write if dest dir missing / ceil tokens on cancel / classify ECONNRESET as cancelled not 5xx / queue max wait 60s then 503 retry / skip embedding dim mismatch / stall-if-no-event 20s mid-stream / strip UTF-16 NUL padding / tool name max 64 / reject recursive same tool name >8 / skip completed plan steps on resume / gzip checkpoint >64KiB / Last-Event-ID parse int-only / glob match file size 1MiB / redact Authorization Bearer / refuse host_bash on computer-only turn / subagent inherit remaining step budget / concatenate split tool_call fragments / never retry 402 / combined stdout+stderr 96KiB / ping only if last write >15s / unicode slash homoglyph refuse / session lock owner pid check / Prisma disconnect retryable / default tool timeout 30s / close SSE then settle credits.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo; 0 x 402 Insufficient Balance desde StartedAt 3H42 `2026-08-21T12:14:25Z`). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h43-invariants.test.js` + `tests/ola-3h42-invariants.test.js` + `tests/ola-3h41-invariants.test.js` (wave 3H41|3H42|3H43). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H42) | Despues (3H43) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | turn wall 120s + abort siblings | **subagent inherit remaining step budget** + **skip completed plan steps on resume** + **mid-stream stall 20s** | subagent_budget; plan_skip_completed; stream_stall |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | id uniqueness + schema clamp + missing-brace | **32KiB arg cap + marker** + **unescaped-newline JSON** + **optional null coerce** + **concat split fragments** + **tool name max 64** + **same-name >8** | tool_args_cap; json_newline_repair; tool_name_length; tool_recursion |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | plan step failed twice | **skip completed steps on resume** | plan_skip_completed |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | pin last tool error + drop tools >6 steps | **pins + last 3 user turns** + **skip embedding dim mismatch** | compact_pins_last3; embedding_dim |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | tombstone + restore last SSE id | **gzip ckpt >64KiB** + **Last-Event-ID int-only** + **lock owner pid** | ckpt_gzip; sse_id_parse; lock_pid |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse write >2MiB + symlink read | **refuse write if dest dir missing** + **unicode slash homoglyph** + **glob file 1MiB** | dest_dir_missing; path_homoglyph; glob_file_size |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | stderr 64KiB | **combined stdout+stderr 96KiB** + **default tool timeout 30s** | combined_cap; tool_timeout_default |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | replay last 32 + 8 hb/min | **max 16 SSE buffers** + **ping if last write >15s** + **int-only Last-Event-ID** | sse_buffer_cap; sse_ping_skip; sse_id_parse |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | identical prompt inflight | **max wait 60s then 503 retry** | queue_wait |
| 10 | Credit/token accounting on cancel | hold + settle + release | refund 0-token + no observation charge | **ceil tokens on cancel** + **close SSE then settle** | credit_ceil; sse_settle_order |
| 11 | Classified errors | code publico ES | emails redact + Retry-After jitter | **ECONNRESET cancelled not 5xx** + **never retry 402** + **Prisma disconnect retryable** + **Bearer redact** + **host_bash blocked** | cancelled; quota_exhausted; prisma_disconnect; auth_redact; host_bash_blocked |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | turn wall 120s + wave 3H42 | **stall 20s mid-stream** + **wave 3H43** | stream_stall; health 3H43; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H43 mueve caps 1-12 (30 helpers nuevos; 3H42 intacto). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H43 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- glob ignore `node_modules`/`.git` ya estaba en `GLOB_IGNORE_DEFAULTS`. ulimit nproc ya en `sandboxUlimitSpec`. killProcessGroup ya existia.

## 3H43 live (21-ago 09:57 Lima)

Codigo 3H43 shipped. Tests: `ola-3h43-invariants.test.js` + `ola-3h42-invariants.test.js` + `ola-3h41-invariants.test.js` (wave acepta 3H43). TTFB live unmeasured (no se llamo DeepSeek en smoke largo). 0 x 402 reales desde 12:14Z. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25).

## 3H42 live (21-ago 06:57 Lima)

Queda en `ola-3h-20260821-0657.md`.

## 3H41 live (21-ago 00:57 Lima)

Queda en `ola-3h-20260821-0057.md`.
