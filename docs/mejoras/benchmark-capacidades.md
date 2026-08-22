# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H46** (2026-08-21 21:57 America/Lima, 2026-08-22T02:57Z). Superpone 3H45 + proto pollution keys / drop duplicate tool call ids / hyphen tool name / cap 32 arg keys / plan title 128 / refuse dup plan step ids / compact keep system prompt / skip expired memory TTL / cap 8 memory hits / CRC32 stamp on ckpt save / lock steal if heartbeat stale / refuse write to /root /mnt /media / skip vendor glob / drop SSE comment frames / cap replay 64 / SSE error event on abort / ignore negative prompt tokens / no charge if cancel before first token / never retry 410 / EHOSTUNREACH as timeout / Postgres ECONNRESET retryable / abort if first byte >45s / stale idempotency >1h / assistant message 64KiB / PEM redact / ECONNABORTED cancelled / refuse subagent same tool as parent / sort memory by score / reject array tool args.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h46-invariants.test.js` + `tests/ola-3h45-invariants.test.js` (wave 3H45|3H46). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H45) | Despues (3H46) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | refuse subagent if parent cancelled + per-tool remaining wall | **refuse subagent same tool as parent** + **TTFB abort 45s** | subagent_same_tool; ttfb_abort |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | JSON 128KiB + digit name + 16 unique + require id | **proto pollution** + **dup tool ids** + **hyphen name** + **32 arg keys** + **reject array args** | proto_pollution; tool_id_dup; tool_name_hyphen; tool_arg_keys; tool_args_array |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | refuse empty plan title | **plan title 128** + **refuse dup step ids** | plan_title_cap; plan_step_dup |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | keep last assistant tool_calls + skip all-zero vectors | **keep system prompt** + **memory TTL** + **8 hits** + **sort by score** | compact_keep_system; memory_ttl; memory_hits_cap; memory_sort |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | CRC32 on load + lock heartbeat 20s | **CRC32 stamp on save** + **steal lock if heartbeat stale** | ckpt_crc_stamp; lock_stale_steal |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse /dev /boot + skip hidden glob | **refuse /root /mnt /media** + **skip vendor glob** | path_root_mnt; glob_vendor |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | strip ANSI + per-tool remaining wall | 3H45 intact (no new sandbox helper) | ansi_strip; tool_wall |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop duplicate ids + event:done | **drop comment frames** + **replay cap 64** + **error event on abort** | sse_comment_drop; sse_replay_cap; sse_abort |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | max 16 queued generate | **stale idempotency >1h** | idempotency_stale |
| 10 | Credit/token accounting on cancel | hold + settle + release | ignore neg completion + observe-only no-charge | **ignore neg prompt tokens** + **no charge if cancel before first token** | usage_ignore_neg_prompt; credit_cancel_pre_token |
| 11 | Classified errors | code publico ES | never retry 451 + ENETUNREACH + sk- redact | **never retry 410** + **EHOSTUNREACH** + **pg ECONNRESET** + **PEM redact** + **ECONNABORTED cancelled** | resource_gone; net_timeout; pg_disconnect; pem_redact; net_cancelled |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | reset stall on token + wave 3H45 | **TTFB abort 45s** + **wave 3H46** | ttfb_abort; health 3H46; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H46 mueve caps 1-6 y 8-12 (29 helpers nuevos; cap 7 sandbox se conserva 3H45). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio).
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H46 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- `jsonRepairTrailingComma`, `stripUtf8BomOnRead`, `stderrByteCapPerCommand`, `maxSubagentDepth`, `classifyEpipeAsCancelled` ya existian. No se rehicieron.

## 3H46 live (21-ago 21:57 Lima)

Codigo 3H46 shipped. Tests: `ola-3h46-invariants.test.js` + `ola-3h45-invariants.test.js` (wave acepta 3H46). TTFB live unmeasured. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25). PAGE WIDTH Word fix StartedAt `2026-08-22T02:24:03Z` no se revirtio (doc-engine/ai.js no tocados). FEATURE_DOC_ENGINE=1.

## 3H45 live (21-ago 15:57 Lima)

Queda en `ola-3h-20260821-1557.md`.

2026-08-21 18:57 Lima: 3H46 DEFERRED — Word UPN transform live bug; shipped 21:57.
