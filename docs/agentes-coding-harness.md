# Session harness (AGENTES_CODING_V2 Phase 4a)

TypeScript/Node **tool loop** inside a jailed coding-sandbox session,
wired to existing SiraCode / agent-harness **contracts**. Default
**OFF**. Canonical UI stays `/agentes`.

This is not a `/code` revival, not F7 / SiraComputer, not Daytona, and
not a dump of OpenHands or OpenCode.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6 / §11.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md)
(`OpenHands/software-agent-sdk` MIT — **pattern only**).
Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Harness | `backend/src/services/agentes-coding/harness/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/harness/run` |
| HTTP | `GET …/harness` · `GET …/harness/:runId` |
| HTTP | `POST …/harness/:runId/cancel` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). HITL
permissions, a real xterm pane, and durable BullMQ jobs are later PRs.

## Pattern fusion

Native rewrite. Literal copy ≈ 0 %.

| Source (MIT / already in-repo) | What we took |
|---|---|
| OpenHands software-agent-sdk | plan → tool → result events on a bounded workspace |
| SiraCode `loop.js` / tools | injectable `llmTurn`, AbortSignal, names `read`/`write`/`exec`/`list` |
| `agent-harness/event-stream.js` | structured steps + preview cap (2 KiB) |

No vendor tree, no OpenRouter, no `model_id` in the JSON the client sees.

## Loop

POST (auth) starts a turn on an existing session. The runner:

1. Emits a `plan` step (`Plan`)
2. Calls the **injectable** completion (`createAgentesCodingRouter({ harnessLlm })`). Without an inject it uses a local stub that never talks to a model
3. Executes at most the sandbox quartet: `readFile` / `writeFile` / `exec` / `listFiles`. Paths go through `jailRelPath`
4. Stores steps in-process on the session (same store pattern as export/deploy)

```json
{
  "ok": true,
  "run": {
    "id": "hrn_…",
    "status": "done",
    "prompt": "lee src/app.ts",
    "steps": [
      { "seq": 1, "kind": "plan", "label": "Plan" },
      { "seq": 2, "kind": "tool_call", "label": "Ejecutando", "tool": "read", "args": { "path": "src/app.ts" } },
      { "seq": 3, "kind": "tool_result", "label": "Resultado", "tool": "read", "ok": true, "preview": "…" },
      { "seq": 4, "kind": "done", "label": "Listo" }
    ],
    "text": "…",
    "tokensEstimate": 120,
    "createdAt": 1710000000000
  }
}
```

Caps (env or body): `AGENTES_CODING_HARNESS_MAX_STEPS` (default 8),
`AGENTES_CODING_HARNESS_MAX_TOKENS` (default 8000, ~chars/4),
`AGENTES_CODING_HARNESS_TIMEOUT_MS` (default 30s). One running turn
per session. Destroying the session forgets the store.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PATH_ESCAPE` `E_QUOTA`
`E_TIMEOUT` `E_CANCELLED` `E_HARNESS_FAILED` `E_HARNESS_NOT_FOUND`
`E_SESSION_NOT_FOUND` plus the sandbox catalog
(`docs/agentes-coding-sandbox.md`).

`E_QUOTA` covers step / token / concurrent-run ceilings. Tool path
escape is recorded on the `tool_result` (`ok: false`, `E_PATH_ESCAPE`)
and does not abort the turn.

## Out of scope

Enabling the flag on Lenovo, calling a real model from CI, HITL
ask/allow (Cline pattern), xterm UI-lock exception, BullMQ durability,
Daytona, reviving `/code`, dumping OpenHands/OpenCode, harness chrome
on `/agentes`.

## Tests

```bash
cd backend && node --test tests/agentes-coding-harness.test.js
```
