# Coding terminal channel (AGENTES_CODING_V2 Phase 3d)

Interactive **PTY stub** for a coding-sandbox session. Default **OFF**.
Canonical UI stays `/agentes`. This is not a `/code` revival, not F7 /
SiraComputer, not Daytona, and not an `@xterm/xterm` npm dep.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §7.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md) (`xtermjs/xterm.js`
MIT, **pattern** — JSON/SSE/WebSocket frames a later xterm FitAddon can
consume). Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).
Phase 3a stub: [`docs/agentes-coding-ide.md`](./agentes-coding-ide.md).

## What this PR adds

| Piece | Path |
|---|---|
| Service | `backend/src/services/agentes-coding/terminal/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/terminal` — open channel |
| HTTP | `POST …/terminal/:channelId/{input,resize,exec}` — stdin / size / run |
| SSE | `GET …/terminal/:channelId/stream` — `text/event-stream` |
| WS | `/api/agentes-coding/terminal?channelId=` — injectable `ws` attach |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). The Phase 3a
terminal pane keeps `data-ws-ready` + HTTP `exec`. Replacing that stub
with xterm.js needs a later UI-lock exception + SBOM review.

The stub is **not** `node-pty`. It line-buffers input and runs
`sandbox.exec` with a jailed `cwd`. Transports are injectable
(memory / SSE / WebSocket) so CI never needs a real PTY.

## Contract

Open (auth):

```json
{
  "ok": true,
  "channel": {
    "channelId": "trm_…",
    "sessionId": "csb_…",
    "cwd": ".",
    "cols": 80,
    "rows": 24
  },
  "wsPath": "/api/agentes-coding/terminal?channelId=trm_…",
  "ssePath": "/api/agentes-coding/sessions/csb_…/terminal/trm_…/stream"
}
```

Frames (JSON, both directions):

| Role | `type` | Payload |
|---|---|---|
| client | `input` | `data` (newline runs a command) |
| client | `exec` | `command`, optional `cwd` |
| client | `resize` | `cols`, `rows` |
| client | `signal` | `SIGINT` / `SIGTERM` |
| server | `ready` | ids + cwd + size |
| server | `stdout` / `stderr` | `data` |
| server | `exit` | `exitCode`, `timedOut` |
| server | `error` | `error` (§16) + Spanish `message` |
| server | `closed` | ids |

SSE: `event: <type>` + `data: <json>`. EventSource may pass `?token=`
(copied to `Authorization`). Caddy must not `encode` `text/event-stream`
(I14).

WebSocket attaches an **already opened** channel (`channelId` query).
Missing token → close `4401`. Flag off → close `4404`.

`cwd` is jailed (`jailRelPath` / `/workspace`). `../` and absolute host
paths are `E_PATH_ESCAPE`. Max 4 channels per session.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PATH_ESCAPE` `E_TERMINAL_FAILED`
`E_SESSION_NOT_FOUND` `E_TIMEOUT` `E_QUOTA` `E_CANCELLED` plus the sandbox
catalog (`docs/agentes-coding-sandbox.md`).

## Out of scope

Adding `@xterm/xterm` / `@xterm/addon-fit`, enabling the flag on Lenovo,
`node-pty`, Daytona, reviving `/code`, dumping the xterm.js monorepo.

## Tests

```bash
cd backend && node --test tests/agentes-coding-terminal.test.js
```
