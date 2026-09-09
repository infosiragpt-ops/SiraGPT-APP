# Durable harness jobs (AGENTES_CODING_V2 Phase 4c)

Optional **BullMQ / Redis** backend so a HITL pause or a long tool loop
survives a process restart. Same HTTP API as Phase 4a / 4b. Default
**OFF**. Canonical UI stays `/agentes`.

This is not a new queue product, not Temporal, not Daytona, not a
Prisma migration, and not a dump of `doc-sandbox` tables.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6 / §11.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md)
(in-repo `bullmq` + doc-sandbox / Codex queue **contracts**).
Harness: [`docs/agentes-coding-harness.md`](./agentes-coding-harness.md).
HITL: [`docs/agentes-coding-permissions.md`](./agentes-coding-permissions.md).

## What landed

| Piece | Path |
|---|---|
| Jobs facade | `backend/src/services/agentes-coding/harness/jobs/` |
| Snapshot | `jobs/snapshot.js` — status, steps, pause, permissions, caps, sessionId |
| Store | `jobs/store.js` — injectable Map; optional Redis hashes |
| Queue | `jobs/queue.js` — memory fake or lazy BullMQ |
| Worker | `jobs/worker.js` — start / resume / cancel; no-op if flag off |
| HTTP | unchanged `/api/agentes-coding/sessions/:id/harness*` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays
**off** on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from
this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A real xterm
pane still needs its own UI-lock exception.

## When durable vs memory

| Condition | Path |
|---|---|
| Flag off | HTTP `404 not_found` (unchanged). Worker **does not start** |
| Flag on, no jobs inject, no `REDIS_URL` on that env | in-process loop (Phase 4a/4b) |
| Flag on + injectable `{ jobs }` (tests) | memory store + fake queue |
| Flag on + `REDIS_URL` (and `AGENTES_CODING_HARNESS_JOBS` not `0`) | Redis snapshot + BullMQ |
| `NODE_ENV=production` | flag helper is false → memory/404; worker no-op |

`REDIS_URL` on `process.env` does **not** flip unit tests: they pass a
local `env` object without that key. CI default path never opens Redis.

## Persist / resume

Authoritative run state is the snapshot (Redis or memory), not BullMQ
job data. Job payload carries `runId`, `sessionId`, `action`
(`start` / `resume` / `cancel`) and a snapshot fallback. Session file
bytes stay in the coding-sandbox jail. **Phase 4e:** docker / volume
drivers persist those bytes on a host bind-mount
(`AGENTES_CODING_SANDBOX_DATA_DIR`) so a process restart can reattach
the same workspace; the memory driver still dies with the process. See
[`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

On HITL (`awaiting_permission`) the worker persists the pause
(transcript, current tool call, remaining calls) **without** `llmTurn`
or `AbortController`. Permission resolve **re-enqueues** `resume`.
Reject / cancel persist a terminal snapshot (`E_PERMISSION_DENIED` /
`E_CANCELLED`).

**Phase 4d:** when the worker has no injectable `llmTurn`, it uses
`harness/llm.js` (same brand aliases, same Spanish `E_PROVIDER` /
`E_TIMEOUT`). Tests keep injecting fakes. See
[`docs/agentes-coding-harness.md`](./agentes-coding-harness.md).

One active run per session still applies (store + in-process). Caps are
unchanged.

## Worker (Lenovo-safe)

`startHarnessWorker` / `startSharedWorker` return `null` when the flag
is off or `REDIS_URL` is absent. Boot in `backend/index.js` is
try/catch. The queue is **not** on the critical health list.

`AGENTES_CODING_HARNESS_JOBS=0` forces the in-process path even if Redis
is configured.

## Pattern fusion

Native rewrite. Literal copy ≈ 0 %.

| Source (already in-repo) | What we took |
|---|---|
| `doc-sandbox/queue` | enqueue contract, `attempts: 1`, jobId idempotency, delivery confirm |
| `codex/run-queue` | flag-gated worker, injectable processor, no-op when off |
| Phase 4a/4b harness | same run / permission HTTP + Spanish `E_*` |

No document-sandbox tables. No new npm dependency (`bullmq` already in
`backend/package.json`).

## Errors (Spanish)

`E_HARNESS_QUEUE` (no se pudo encolar) plus the Phase 4a/4b catalog
(`docs/agentes-coding-harness.md`). Flag off → HTTP `404 not_found`.

## Out of scope

Enabling the flag on Lenovo, real xterm UI-lock exception, Cline
webview, Temporal, Daytona, Prisma job table, reviving `/code`,
dumping OpenHands / doc-sandbox processors.

## Tests

```bash
cd backend && node --test tests/agentes-coding-harness.test.js tests/agentes-coding-harness-permissions.test.js tests/agentes-coding-harness-jobs.test.js tests/agentes-coding-harness-llm.test.js tests/agentes-coding-harness-todo-smoke.test.js
```
