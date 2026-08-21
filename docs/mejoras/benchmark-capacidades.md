# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H41** (2026-08-21 00:57 America/Lima, 2026-08-21T05:57Z). Superpone 3H40 + prune checkpoints last 8 / SSE Last-Event-ID persist / single-quote+comment JSON repair / max output tokens 8192 / drop consecutive duplicate tool calls / classify 5xx vs 4xx vs timeout / compact keep last user+assistant pair / redact key-like tool args / bound steps on checkpoint resume / reject empty tool name / reject NUL in path / skip heartbeat if write would block / wait inflight then drop on cancel / token usage on error path / pgvector query timeout 2s / refuse computer_* if flag off / coerce true/false strings / max 2 concurrent subagents / drop empty assistant turn / SSE retry:ms pad / sandbox tmp cleanup on timeout / subagent inherits abort / truncate tool result with marker / isolate parallel tool timeout / hold-settle never double-charge / additionalProperties false.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**3H41 previa (2026-08-20 21:57 America/Lima) DEFERRED** por DeepSeek 402. Esta corrida 00:57 Lima SI shippea 3H41. TTFB live Flash: **unmeasured** (no se llamo DeepSeek en smoke largo; ultimo 402 log 03:33Z, generates 200 posteriores sin 402). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h41-invariants.test.js` + `tests/ola-3h40-invariants.test.js` (wave 3H40|3H41). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H40) | Despues (3H41) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | hard cap 32 + nested abort | **max 2 concurrent subagents** + **subagent inherits abort** + **drop empty assistant turn** | subagent_concurrency; inherited abort; empty_turn |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | unquoted keys + NUL + integer coerce | **single-quote+comment JSON repair** + **drop consecutive dup tools** + **reject empty tool name** + **true/false coerce** + **additionalProperties false** + **truncate result with marker** | repaired JSON; dropped:n; empty_tool_name |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | empty-model x2 + budget /5 | **bound remaining steps on checkpoint resume** + **isolate parallel tool timeout** | remaining capped; timeoutMs per tool |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | stale images + facts 30d | **keep last user+assistant pair** + **pgvector query timeout 2s** | keepIndexes; pgvector_timeout |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | syntax rollback | **prune checkpoints keep last 8** + **SSE Last-Event-ID persist cursor** | pruned:true; cursor monotonic |
| 6 | File edit exact diff + verify | unique hunk + scheduler | symlink write + UTF-8 BOM | **reject NUL in path** | nul_path |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | SIGTERM+SIGKILL 1500ms + stdout 64KiB | **tmp cleanup on timeout** | cleaned:true sandbox_timeout |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | pad idle>10s + destroy on close | **retry:ms in pad** + **skip heartbeat if write would block** | retry: 2000; skip:true |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | generate/user cap + steal lock | (sin cambio de cola; starve ya en 3H40) | generate_overloaded intacto |
| 10 | Credit/token accounting on cancel | hold + settle + release | never charge 401/403 | **hold-settle never double-charge** + **usage on error path even sin completion** + **wait inflight then drop** | credit_hold_reuse; completionTokens:0 |
| 11 | Classified errors | code publico ES | IPv4 redact + EPIPE cancelled | **5xx vs 4xx vs timeout** + **redact key-like tool args** + **refuse computer_* if flag off** | http_5xx; [REDACTED]; computer_flag_off |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | glob cap 500 + TTFB 8s + wave 3H40 | **clamp max output tokens 8192** + **wave 3H41** | maxTokens 8192; health 3H41; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H41 mueve caps 1-12 (26 helpers nuevos; 3H40 intacto). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. 3H36 fail-closed lo honra.
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos). p50/p95 de 3H39 son scripted.

## 3H41 live (21-ago 00:57 Lima)

Codigo 3H41 shipped. Tests: `ola-3h41-invariants.test.js` + `ola-3h40-invariants.test.js` (wave acepta 3H41). TTFB live unmeasured (no se llamo DeepSeek en smoke largo). Ultimo 402 real en logs: 2026-08-21T03:33:54Z; generates 200 posteriores (03:39, 04:32) sin Insufficient Balance. Hotfix chat 02:56Z se conserva.

## 3H41 diferida previa (20-ago 21:57 Lima)

Aquella corrida no aplico codigo: DeepSeek 402. Queda documentada en `ola-3h-20260820-2157.md`.
