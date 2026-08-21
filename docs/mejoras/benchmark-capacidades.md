# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H45** (2026-08-21 15:57 America/Lima, 2026-08-21T20:57Z). Superpone 3H44 + tool result JSON cap 128KiB / leftover single-quoted JSON keys / reject -0 numbers / drop duplicate SSE event ids / compact never drop last assistant tool_calls / refuse write to /dev /boot / ignore negative completion tokens / classify ENETUNREACH as timeout / max 16 queued generate / skip all-zero memory vectors / reset stall count on token / strip U+E0000 tag chars / reject tool name starting with digit / max 16 unique tools per turn / refuse empty plan title / CRC32 check on checkpoint load / skip hidden glob files / redact sk- prefixes / refuse computer_* if session missing / refuse subagent if parent cancelled / require tool call id / never retry 451 / strip ANSI from sandbox out / session lock heartbeat every 20s / Redis EAI_AGAIN retryable / per-tool remaining wall clock / end SSE with event:done / sort tools by name for cache / observe-only no-charge.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo; 0 x 402 Insufficient Balance desde StartedAt 3H44 `2026-08-21T18:18:47Z`). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h45-invariants.test.js` + `tests/ola-3h44-invariants.test.js` (wave 3H44|3H45). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H44) | Despues (3H45) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | cancel if 3 stalls + plan 24 + min remaining 1 | **reset stall on token** + **refuse empty plan title** + **refuse subagent if parent cancelled** + **per-tool remaining wall** | stall_reset; plan_title_empty; subagent_parent_cancelled; tool_wall |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | inflight 8 + // comments + NaN/Infinity + charset + A→B→A + drop trailing + tool list 8KB | **JSON result 128KiB** + **single-quoted keys leftover** + **reject -0** + **digit tool name** + **16 unique tools/turn** + **require tool id** + **sort tools by name** | tool_result_json_cap; json_single_quote_key; negative_zero; tool_name_digit; unique_tools_cap; tool_id_required |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | max 24 plan steps | **refuse empty plan title** | plan_title_empty |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | summary 2KiB + skip NaN score | **keep last assistant tool_calls** + **skip all-zero vectors** | compact_keep_tool_calls; memory_zero_vector |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | refuse ckpt >1MiB + id no backwards + lock ttl 90s | **CRC32 on load** + **lock heartbeat 20s** | ckpt_crc; lock_heartbeat |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse /etc /proc /sys + glob 32 + bidi strip | **refuse /dev /boot** + **skip hidden glob** + **strip U+E0000 tags** | path_dev_boot; glob_hidden; tag_strip |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | per-line 8KiB + hard cap 120s | **strip ANSI** + **per-tool remaining wall** | ansi_strip; tool_wall |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop >2 min + client gone 30s + flush last | **drop duplicate event ids** + **event:done** | sse_dup_id; sse_done |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | fair-share extra slot if wait >20s | **max 16 queued generate** | queue_generate_cap |
| 10 | Credit/token accounting on cancel | hold + settle + release | never negative usage + screenshot-only no-charge | **ignore negative completion tokens** + **observe-only no-charge** | usage_ignore_neg_completion; credit_observe |
| 11 | Classified errors | code publico ES | never retry 413 + Redis ECONNREFUSED + JWT redact + computer_* no userId | **never retry 451** + **ENETUNREACH timeout** + **Redis EAI_AGAIN** + **sk- redact** + **computer_* no session** | legal_unavailable; net_timeout; redis_disconnect; sk_redact; computer_no_session |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | 3 stalls cancel + wave 3H44 | **reset stall on token** + **wave 3H45** | stall_reset; health 3H45; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H45 mueve caps 1-12 (29 helpers nuevos; 3H44 intacto). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H45 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- `parseLastEventIdIntOnly` ya ignora Last-Event-ID no-digito. `destroySseOnClientClose` ya hace destroy en `req.close`. No se rehicieron.

## 3H45 live (21-ago 15:57 Lima)

Codigo 3H45 shipped. Tests: `ola-3h45-invariants.test.js` + `ola-3h44-invariants.test.js` (wave acepta 3H45). TTFB live unmeasured (no se llamo DeepSeek en smoke largo). 0 x 402 reales desde 18:18Z. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25).

## 3H44 live (21-ago 12:57 Lima)

Queda en `ola-3h-20260821-1257.md`.

## 3H43 live (21-ago 09:57 Lima)

Queda en `ola-3h-20260821-0957.md`.
