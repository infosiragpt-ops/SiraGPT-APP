# Rubrica de capacidades del motor — SiraGPT vs Claude Code / Cowork

Version: **3H40** (2026-08-20 18:57 America/Lima, 2026-08-20T23:57Z). Superpone 3H39 + hard cap 32 tools/step / abort nested subagents on parent halt / unquoted-key JSON repair / drop NUL args / integer coerce / empty-model circuit / budget hint every 5 steps / drop stale image-pdf / skip facts >30d / rollback on syntax fail / refuse symlink write / strip UTF-8 BOM / SIGTERM+SIGKILL 1500ms / stdout 64KiB helper / SSE proxy pad / destroy SSE on close / max 2 generate/user / steal lock heartbeat >45s / never charge 401/403 / redact IPv4 / EPIPE response cancelled / glob cap 500 / TTFB watchdog 8s.
Superficie: motor backend `/chat` + `/code`. **UI no forma parte de esta rubrica.**
Generate path: DeepSeek V4 Flash / Pro only (`openrouter: false`).

**3H41 (2026-08-20 21:57 America/Lima, 2026-08-21T02:57Z) DEFERRED.** No se aplico codigo de oleada 3H41. DeepSeek 402 Insufficient Balance: no se puede smoke live `/chat` `/code`. 3H40 permanece live (`adapter.wave=3H40`, `openrouterGenerate=false`). Hotfix chat 2026-08-21T02:56:29Z: `computerOnly` gated a intent (no cada `disableAgentic` de /code, incl. "hola"), cap CDP observe, 402 clasificado en vez de sanitize generico "Hubo un problema". TTFB live unmeasured because 402. No se inventaron metricas.

Como se mide: invariantes `tests/ola-3h40-invariants.test.js` + `tests/ola-3h39-invariants.test.js` + `tests/ola-3h38-invariants.test.js` + `tests/ola-3h37-invariants.test.js` + `tests/ola-3h36-invariants.test.js` + `tests/ola-3h35-invariants.test.js` + `tests/ola-3h34-invariants.test.js` + `tests/ola-3h33-invariants.test.js` + `tests/ola-3h32-invariants.test.js` + `tests/ola-3h31-invariants.test.js`. `/health` live (sin Fal, sin cobro DeepSeek).

| # | Capacidad | Metrica | Antes (3H39) | Despues (3H40) | Target |
|---|---|---|---|---|---|
| 1 | Bucle agentico multi-paso sin humano | tool-chain >=3 + subagent + stopWhen + wall clock | call-order results + cancel in-flight | **hard cap 32 tools/step halt** + **abort nested depth>=1 on parent halt** | too_many_tools; aborted:n |
| 2 | Tool-call reliability | repair + schema + alias + isolate + result cap | trailing-comma + aliases + nested depth 6 | **unquoted keys JSON** + **drop NUL** + **integer coerce "3"/"3.2"** | repaired JSON; stripped:true; coercion_rejected |
| 3 | Planning: budget + loop cut + DLQ + DAG | catalog + kind map + circuit | subagent depth 2 + wall-clock <5s | **empty model x2 halt** + **budget hint step%5 remaining<=10** | empty_model; inject:true |
| 4 | Long-context compact + pin + memory | compact + pin + retrieve + ACL + score | merge dup users + hash dedupe | **drop stale image/pdf > last 2 user turns** + **skip facts >30d** | dropped images; skipped:n |
| 5 | Session resume + checkpoint rollback | durable ckpt + CAS | refuse stale checksum edit | **rollback previous bytes if syntaxCheck fails** | rolledBack:true |
| 6 | File edit exact diff + verify | unique hunk + scheduler | hunk context + atomic tmp + UNC | **refuse write through symlink** + **strip UTF-8 BOM** | symlink_write; bom:true |
| 7 | Sandbox exec stream/timeout/cleanup | onChunk; destroy; limits; net deny | no-new-privs + LD_PRELOAD scrub | **SIGTERM then SIGKILL 1500ms** + **stdout 64KiB helper** | killed:true; truncated:true |
| 8 | SSE robustness | per-session seq + heartbeat + gap + window | drop buffered tokens + SSE id monotonic | **comment pad idle>10s** + **destroy writer on req close** | padded:true; destroyed:true |
| 9 | Per-session queue + event order | fifo maxPending=8 + idempotency + hash | coalesced same call id | **3rd generate/user overloaded** + **steal lock heartbeat >45s** | generate_overloaded; stolen:true |
| 10 | Credit/token accounting on cancel | hold + settle + release | settle if client gone | **never charge 401/403** | charge:false unauthorized |
| 11 | Classified errors | code publico ES | json_parse + cancelled AbortError | **redact IPv4 x.x.x.x** + **EPIPE/ECONNRESET response → cancelled** | 0 IPv4; cancelled != net_reset |
| 12 | Latency p50/p95 first-token y turn-end | P2 + firstByte + flags | skip dup web_fetch + wave 3H39 | **glob/grep cap 500** + **TTFB watchdog 8s scripted** + **wave 3H40** | glob_cap; ttfb_watchdog; health 3H40 |

## Como se mueve un numero

Ninguna oleada cierra sin una celda **Despues** distinta de **Antes**. 3H40 mueve caps 1-12 (hard cap 32 tools, nested abort, unquoted JSON, NUL strip, integer coerce, empty-model circuit, budget every 5, stale images, facts 30d, syntax rollback, symlink write, UTF-8 BOM, SIGTERM+SIGKILL 1500ms, stdout 64KiB helper, SSE pad, destroy on close, generate/user cap, steal stale lock, never charge 401/403, IPv4 redact, EPIPE cancelled, glob cap 500, TTFB 8s).

## Leftovers (no son esta oleada)

- HMAC inbound 503 `hmac_secret_missing` (falta `SIRAGPT_WEBHOOK_HMAC_SECRET`). No se invento secreto.
- `mcp_policy` deny-all para hosts NUEVOS (`SIRAGPT_MCP_ALLOWED_HOSTS` vacio). 3H32 reusa hosts ya conectados en la sesion; no abre una allowlist.
- `chat_run_worker` skipped dormant (`dormant_ok:true`). Encenderlo cambiaria generate a BullMQ y romperia SSE in-process.
- `SIRAGPT_REFRESH_TOKEN_ROTATION` unset (no encender sin dual-read).
- `SIRAGPT_SANDBOX_NET_ALLOW` unset — deny-all honesto. No inventar hosts. 3H36 fail-closed lo honra.
- Sandbox interpreter sigue `local` (gVisor `runsc` es el agent-runner). Este path declara `usesRunsc: false`.
- `create_file` / `delete_file` / `move_file` / `notebook_edit` no existen live (allowlist no los inventa).
- Live Flash TTFB no se midio con DeepSeek (no quemar creditos). p50/p95 de 3H39 son scripted.

## 3H41 diferida (20-ago 21:57 Lima)

No live Flash TTFB: unmeasured because 402. Extreme block = pago DeepSeek. Tests pin 3H40: 29 pass / 0 fail; combined `ola-3h-invariants.test.js`: 16 pass / 0 fail (proceso de test no sale solo por handles abiertos de DB pool; no es fallo de pin). Backend no recreado (StartedAt 2026-08-21T02:56:29Z).
