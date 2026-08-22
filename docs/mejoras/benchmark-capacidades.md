# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H50** (2026-08-22 09:57 America/Lima, 2026-08-22T14:57Z). Superpone 3H49 + tool name at / arg key 48 / tool index int / plan priority known / step id 32 / drop unknown owner / refuse neg eta / skip unknown memory source / value 2048 / refuse neg ttl / ckpt rev non-neg / lock session match / skip lockfiles / refuse /sys / skip min.js / drop SSE done / SSE retry 30s / ignore neg audio / no charge if model unavailable / never retry 409 / EAFNOSUPPORT / mongo not primary / parallel subagents 4 / idempotency no leading dash / user 80 paragraphs / GitHub PAT redact / refuse subagent owner blank / sandbox workdir 256 / refuse pid-ipc-userns host / ckpt meta 512. Superpone 3H48 + tool name colon / arg nesting 8 / call id required / plan status known / step count 48 / drop blank titles / skip unknown memory kind / key 64 / refuse NaN score / ckpt session required / lock token required / skip .env glob / refuse /etc / skip dist glob / drop SSE empty data / SSE id 64 / ignore neg reasoning tokens / no charge if safety blocked / never retry 403 / ENETRESET unavailable / Redis LOADING / parallel tools 8 / idempotency alnum-dash / user 8000 words / Stripe key redact / refuse subagent parent missing / sandbox stderr 500 / gid 0 refuse / env value 256 / refuse privileged / refuse cap-add / ckpt payload 64KiB.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h50-invariants.test.js` + `tests/ola-3h49-invariants.test.js` (wave 3H49|3H50). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H49) | Despues (3H50) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | refuse subagent name slash + tool wall 60s | **refuse subagent parent missing** + **parallel tools 8** | subagent_parent_missing; parallel_tools_cap |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | slash name + arg array 64 + name must be string | **colon name** + **arg nest 8** + **call id required** | tool_name_colon; tool_arg_nest; tool_call_id_blank |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | depends array + desc 256 + drop empty ids + sort by depends | **status known** + **step count 48** + **drop blank titles** | plan_status_unknown; plan_step_count; plan_step_blank_title |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | blank ns skip + ns 32 + upsert id required | **unknown kind skip** + **key 64** + **refuse NaN score** | memory_kind_unknown; memory_key_cap; memory_score_nan |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | refuse ckpt without seq + lock owner required | **refuse ckpt without session** + **lock token required** + **payload 64KiB** | ckpt_session_missing; lock_token_empty; ckpt_payload_cap |
| 6 | File edit exact diff + verify | unique hunk + scheduler | refuse /opt + skip .git + skip coverage | **refuse /etc** + **skip .env** + **skip dist** | path_etc; glob_dot_env; glob_dist |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | env keys 16 + net refuse + stdout 500 + uid 0 refuse | **stderr 500** + **gid 0 refuse** + **env value 256** + **privileged refuse** + **cap-add refuse** | sandbox_stderr_lines; sandbox_gid_zero; sandbox_env_value; sandbox_privileged; sandbox_cap_add |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop ping + event name 32 | **drop empty data** + **id 64** | sse_empty_data; sse_id_cap |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | idempotency key no whitespace | **idempotency key alnum-dash** | idempotency_key_alnum |
| 10 | Credit/token accounting on cancel | hold + settle + release | ignore neg cached + no charge if prompt filtered + user 400 lines | **ignore neg reasoning** + **no charge if safety blocked** + **user 8000 words** | usage_ignore_neg_reasoning; credit_safety_blocked; user_msg_words |
| 11 | Classified errors | code publico ES | never retry 401 + EPROTO + sqlite busy + GCP SA + ENOBUFS | **never retry 403** + **ENETRESET** + **redis LOADING** + **Stripe key redact** | forbidden; enetreset; redis_loading; stripe_key_redact |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | tool wall 60s + wave 3H48 | **parallel tools 8** + **wave 3H49** | parallel_tools_cap; health 3H49; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H50 mueve caps 1-12 (32 helpers nuevos). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio).
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. No se reabro en 3H49 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos).
- Helpers 3H45/3H46/3H47/3H48/3H49 no se rehicieron.

## 3H50 live (22-ago 09:57 Lima)

Codigo 3H50 shipped. Tests: `ola-3h50-invariants.test.js`. TTFB live unmeasured. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25). PAGE WIDTH Word fix bind-mounts (doc-engine/ai.js) no tocados. FEATURE_DOC_ENGINE=1. 402 ES restaurado en public-stream-error. Frontend no recreate (restore-code job in parallel).

## 3H49 live (22-ago 06:57 Lima)

Codigo 3H49 shipped. Tests: `ola-3h49-invariants.test.js`. TTFB live unmeasured. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25). PAGE WIDTH Word fix bind-mounts (doc-engine/ai.js) no tocados. FEATURE_DOC_ENGINE=1. 402 ES restaurado en public-stream-error.

## 3H48 live (22-ago 03:57 Lima)

Queda en `ola-3h-20260822-0357.md`.
