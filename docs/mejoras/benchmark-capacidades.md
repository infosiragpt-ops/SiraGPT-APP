# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H42** (2026-08-21 06:57 America/Lima, 2026-08-21T11:57Z). Superpone 3H41 + tool_call id uniqueness across resume / schema integer-number clamp min-max / JSON missing-brace repair with budget / refund hold if no tokens used / pin last tool error on compact / SSE replay last 32 from cursor / reject identical prompt inflight same session / refuse write >2MiB / skip empty embedding upsert / never charge tool-only observation loops / total-turn wall 120s / case-insensitive enum repair / strip zero-width chars from args / max JSON array length 256 / Retry-After jitter 50-150ms / checkpoint tombstone / stderr 64KiB cap / drop tool results older than 6 steps / reject tool name with whitespace / numeric id strings stay strings / session event seq must increase / abort siblings on parent cancel token / redact emails in logs / max 8 heartbeats/min / refuse read through symlink / plan step failed if tool error twice / restore last SSE id on resume.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**TTFB live Flash: unmeasured** (no se llamo DeepSeek en smoke largo; 0 x 402 Insufficient Balance desde StartedAt 3H41 `2026-08-21T06:33:46Z`). No se inventaron metricas p50/p95.

Como se mide: invariantes `tests/ola-3h42-invariants.test.js` + `tests/ola-3h41-invariants.test.js` + `tests/ola-3h40-invariants.test.js` (wave 3H40|3H41|3H42). `/health` live (sin cobro DeepSeek en smoke largo).

| # | Capacidad | Metrica | Antes (3H41) | Despues (3H42) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | max 2 subagents + inherit abort | **total-turn wall 120s** + **abort siblings on parent cancel token** + **plan step failed if tool error twice** | turn_wall; turn_cancelled; plan_step_failed |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | single-quote JSON + empty name | **id uniqueness across resume** + **schema min/max clamp** + **missing-brace repair** + **case-insensitive enum** + **zero-width strip** + **array cap 256** + **id strings stay strings** + **reject whitespace tool name** | tool_id_resume_dup; schema_clamp; enum_repair; tool_name_whitespace |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | bound steps on resume | **plan step failed twice** | plan_step_failed |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | keep last user+asst pair | **pin last tool error** + **drop tool results older than 6 steps** + **skip empty embeddings** | pin_tool_error; compact_old_tools; empty_embedding |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | prune last 8 + SSE cursor persist | **tombstone deleted ckpt** + **restore last SSE id** + **tool ids unique across resume** | ckpt_tombstone; sse lastEventId |
| 6 | File edit exact diff + verify | unique hunk + scheduler | reject NUL path | **refuse write >2MiB** + **refuse read through symlink** | write_too_large; symlink_read |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | tmp cleanup on timeout + stdout 64KiB | **stderr 64KiB cap** | stderr_cap |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | retry:ms + skip blocked hb | **replay last 32 from cursor** + **max 8 heartbeats/min** + **event seq must increase** | sse_resume; heartbeat_cap; event_order |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | generate/user cap + steal lock | **reject identical prompt inflight same session** | identical_prompt_inflight |
| 10 | Credit/token accounting on cancel | hold + settle + release | hold-settle never double-charge | **refund hold if 0 tokens** + **never charge observation loops** | credit_no_usage; credit_observation |
| 11 | Classified errors | code publico ES | 5xx/4xx/timeout + key redact | **redact emails in logs** + **Retry-After jitter 50-150ms** | [REDACTED_EMAIL]; jitterMs |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | TTFB 8s + wave 3H41 | **turn wall 120s** + **wave 3H42** | turn_wall; health 3H42; TTFB live unmeasured |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H42 mueve caps 1-12 (27 helpers nuevos; 3H41 intacto). TTFB live Flash unmeasured (no smoke LLM largo).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. 3H36 fail-closed lo honra. No se reabro en 3H42 (romperia computer).
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos). p50/p95 de 3H39 son scripted.
- glob ignore `node_modules`/`.git` ya estaba en `GLOB_IGNORE_DEFAULTS` (3H3x). ulimit nproc ya en `sandboxUlimitSpec`.

## 3H42 live (21-ago 06:57 Lima)

Codigo 3H42 shipped. Tests: `ola-3h42-invariants.test.js` + `ola-3h41-invariants.test.js` + `ola-3h40-invariants.test.js` (wave acepta 3H42). TTFB live unmeasured (no se llamo DeepSeek en smoke largo). 0 x 402 reales desde 06:33Z. Hotfix chat 02:56Z se conserva (`persistentComputerTools`, computerOnly gated, CDP 8KiB, MAX_CONTROL_STEPS=25).

## 3H41 live (21-ago 00:57 Lima)

Queda en `ola-3h-20260821-0057.md`.
