# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H48** (2026-08-22 03:57 America/Lima, 2026-08-22T08:57Z). Superpone 3H47 + tool name slash / cap arg arrays 64 / name must be string / plan depends must be array / plan desc 256 / drop empty step ids / skip blank memory namespace / ns 32 chars / refuse empty memory id / refuse ckpt without seq / lock owner required / skip .git glob / refuse /opt / skip coverage glob / drop SSE ping frames / SSE event name 32 / ignore negative cached tokens / no charge if prompt filtered / never retry 401 / EPROTO unavailable / SQLite BUSY retryable / abort tool wall 60s / idempotency key whitespace / user message 400 lines / GCP service-account redact / ENOBUFS unavailable / refuse subagent name slash / sandbox env keys 16 / refuse sandbox network / stdout 500 lines / refuse uid 0 / sort plan by depends then order.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h48-invariants.test.js` + `tests/ola-3h47-invariants.test.js` (wave 3H47|3H48). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H47) | Despues (3H48) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | refuse empty subagent name + idle 30s mid-tool | **refuse subagent name slash** + **tool wall 60s** | subagent_name_slash; tool_wall_abort |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | trailing dot + arg string 4096 + object tool name | **slash name** + **arg array 64** + **name must be string** | tool_name_slash; tool_arg_array; tool_name_type |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | steps array + step title 80 + sort by order | **depends must be array** + **desc 256** + **drop empty ids** + **sort by depends then order** | plan_depends_type; plan_desc_cap; plan_step_empty_id; plan_step_depends_sort |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | keep last user + score floor + fact 512 + dup ids | **blank namespace skip** + **ns 32** + **upsert id required** | memory_ns_blank; memory_ns_cap; memory_id_empty |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | refuse ckpt without CRC + lock TTL expire | **refuse ckpt without seq** + **lock owner required** | ckpt_seq_missing; lock_owner_empty |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse /var/log /var/run /run + skip node_modules | **refuse /opt** + **skip .git** + **skip coverage** | path_opt; glob_dot_git; glob_coverage |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | argv 24 + cwd not / + code 256KiB + timeout required | **env keys 16** + **net refuse** + **stdout 500 lines** + **uid 0 refuse** | sandbox_env_keys; sandbox_net; sandbox_stdout_lines; sandbox_uid_zero |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop retry + data 32KiB + idle comment | **drop ping frames** + **event name 32** | sse_ping_drop; sse_event_name |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | idempotency key 128 chars | **idempotency key no whitespace** | idempotency_key_ws |
| 10 | Credit/token accounting on cancel | hold + settle + release | ignore neg total + no charge if no model call + user 32KiB | **ignore neg cached tokens** + **no charge if prompt filtered** + **user 400 lines** | usage_ignore_neg_cached; credit_prompt_filtered; user_msg_lines |
| 11 | Classified errors | code publico ES | never retry 408 + ETIMEDOUT + mysql ECONNRESET + AWS key + ECONNREFUSED | **never retry 401** + **EPROTO** + **sqlite busy** + **GCP SA redact** + **ENOBUFS** | unauthorized; eproto; sqlite_busy; gcp_sa_redact; enobufs |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | idle 30s mid-tool + wave 3H47 | **tool wall 60s** + **wave 3H48** | tool_wall_abort; health 3H48; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H48 mueve caps 1-12 (32 helpers nuevos). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio).
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H48 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- Helpers 3H45/3H46/3H47 no se rehicieron.

## 3H48 live (22-ago 03:57 Lima)

Codigo 3H48 shipped. Tests: `ola-3h48-invariants.test.js`. TTFB live unmeasured. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25). PAGE WIDTH Word fix bind-mounts (doc-engine/ai.js) no tocados. FEATURE_DOC_ENGINE=1. 402 ES restaurado en public-stream-error.

## 3H47 live (22-ago 00:57 Lima)

Queda en `ola-3h-20260822-0057.md`.
