# Todo-app CI smoke (AGENTES_CODING_V2 Phase 4f)

API-only **golden** that drives the coding harness through a tiny
todo-app fixture in the **memory** sandbox. Default **OFF**. Canonical
UI stays `/agentes`.

This is not a browser e2e, not Playwright, not a `/code` revival, not
F7 / SiraComputer, not Daytona, and not a dump of SWE-bench.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6 / §11.
Harness: [`docs/agentes-coding-harness.md`](./agentes-coding-harness.md).
HITL: [`docs/agentes-coding-permissions.md`](./agentes-coding-permissions.md).
Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md)
(`SWE-bench/SWE-bench` MIT — **fixture idea only**).

## What landed

| Piece | Path |
|---|---|
| Fixture | `backend/tests/fixtures/agentes-coding-todo/workspace/` (`package.json` + `src/app.js`) |
| Scripted turns | `backend/tests/fixtures/agentes-coding-todo/index.js` |
| Smoke | `backend/tests/agentes-coding-harness-todo-smoke.test.js` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays
**off** on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from
this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A real xterm
pane is a later UI-lock exception. No new HTTP paths — the smoke uses
the Phase 2a session + Phase 4a/4b harness routes that already exist.

## Loop the smoke asserts

1. `createSession` on the **memory** driver (CI default; ephemeral Map)
2. `POST /sessions/:id/harness/run` with an injectable `llmTurn`
3. Scripted completion emits `plan` → `write package.json` →
   `write src/app.js` → `done`
4. Session files match the fixture bytes; run `status` is `done`
5. Optional HITL: the same turn then `exec` `node src/app.js add …`,
   pauses as `awaiting_permission`, `allow_once` resumes, exec result
   is ok. Memory `execImpl` is injected (the memory driver never
   spawns a shell)

Offline only. Tests pass a local `ON = { AGENTES_CODING_V2: '1' }` into
`createCodingSandbox` / the router. They never assign
`process.env.AGENTES_CODING_V2`.

## Pattern fusion

Native rewrite. Literal copy ≈ 0 %.

| Source (MIT / already in-repo) | What we took |
|---|---|
| SWE-bench corpus idea | a tiny, deterministic workspace golden — not the Python harness, not the dataset |
| OpenHands / SiraCode loop | plan → tool → files already landed in Phase 4a |
| Cline HITL (Phase 4b) | optional `allow_once` on `exec` |

No vendor tree, no OpenRouter, no `model_id` in the JSON the client sees.

## Out of scope

Enabling the flag on Lenovo, calling a real model from CI, browser /
Playwright e2e of a generated app, xterm UI-lock exception, Daytona,
reviving `/code`, dumping SWE-bench or OpenHands, harness chrome on
`/agentes`.

## Tests

```bash
cd backend && node --test tests/agentes-coding-harness-todo-smoke.test.js
```
