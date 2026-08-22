# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H47** (2026-08-22 00:57 America/Lima, 2026-08-22T05:57Z). Superpone 3H46 + tool name trailing dot / cap arg strings 4096 / plan steps must be array / plan step title 80 / compact keep last user / memory score floor / fact 512 chars / drop dup memory ids / refuse ckpt without CRC / lock TTL expire / refuse /var/log /var/run /run / skip node_modules glob / drop SSE retry frames / SSE data 32KiB / idle SSE comment / ignore negative total tokens / no charge if no model call / never retry 408 / ETIMEDOUT as timeout / MySQL ECONNRESET retryable / abort idle 30s mid-tool / idempotency key 128 / user message 32KiB / AWS access key redact / ECONNREFUSED unavailable / refuse empty subagent name / sort plan steps by order / reject object tool name / sandbox argv 24 / refuse sandbox cwd / or /root / sandbox code 256KiB / sandbox timeout required.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h47-invariants.test.js` + `tests/ola-3h46-invariants.test.js` (wave 3H46|3H47). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H46) | Despues (3H47) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | refuse subagent same tool + TTFB abort 45s | **refuse empty subagent name** + **idle 30s mid-tool** | subagent_name_empty; tool_idle_abort |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | proto pollution + dup ids + hyphen + 32 keys + array args | **trailing dot name** + **arg string 4096** + **object tool name** | tool_name_dot; tool_arg_string; tool_name_object |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | plan title 128 + refuse dup step ids | **steps must be array** + **step title 80** + **sort by order** | plan_steps_type; plan_step_title_cap; plan_step_sort |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | keep system + TTL + 8 hits + sort by score | **keep last user** + **score floor** + **fact 512** + **dup memory ids** | compact_keep_last_user; memory_score_floor; memory_fact_cap; memory_id_dup |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | CRC32 stamp on save + steal if stale | **refuse ckpt without CRC** + **lock TTL expire** | ckpt_crc_missing; lock_ttl_expired |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse /root /mnt /media + skip vendor | **refuse /var/log /var/run /run** + **skip node_modules** | path_var_log; glob_node_modules |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | 3H45 intact (no 3H46 sandbox helper) | **argv 24** + **cwd not /** + **code 256KiB** + **timeout required** | sandbox_argv_cap; sandbox_cwd_root; sandbox_code_cap; sandbox_timeout_required |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop comments + replay 64 + abort event | **drop retry frames** + **data 32KiB** + **idle comment** | sse_retry_drop; sse_data_cap; sse_idle_comment |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | stale idempotency >1h | **idempotency key 128 chars** | idempotency_key_len |
| 10 | Credit/token accounting on cancel | hold + settle + release | ignore neg prompt + no charge cancel pre-token | **ignore neg total tokens** + **no charge if no model call** + **user msg 32KiB** | usage_ignore_neg_total; credit_no_model; user_msg_cap |
| 11 | Classified errors | code publico ES | never retry 410 + EHOSTUNREACH + pg ECONNRESET + PEM | **never retry 408** + **ETIMEDOUT** + **mysql ECONNRESET** + **AWS key redact** + **ECONNREFUSED** | request_timeout; etimedout; mysql_disconnect; aws_key_redact; net_unavailable |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | TTFB abort 45s + wave 3H46 | **idle 30s mid-tool** + **wave 3H47** | tool_idle_abort; health 3H47; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H47 mueve caps 1-12 (32 helpers nuevos; cap 7 sandbox por fin avanza). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio).
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H47 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- Helpers 3H45/3H46 no se rehicieron.

## 3H47 live (22-ago 00:57 Lima)

Codigo 3H47 shipped. Tests: `ola-3h47-invariants.test.js`. TTFB live unmeasured. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25). PAGE WIDTH Word fix bind-mounts (doc-engine/ai.js) no tocados. FEATURE_DOC_ENGINE=1. 402 ES restaurado en public-stream-error.

## 3H46 live (21-ago 21:57 Lima)

Queda en `ola-3h-20260821-2157.md`.

2026-08-21 18:57 Lima: 3H46 DEFERRED — Word UPN transform live bug; shipped 21:57.
