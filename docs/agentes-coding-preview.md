# Coding sandbox preview (`exposePort`) — AGENTES_CODING_V2 Phase 3e

Signed **ephemeral preview URL** for a coding-sandbox session. Default
**OFF**. Canonical UI stays `/agentes`. This is not a `/code` revival,
not F7 / SiraComputer, not Daytona, and not an OpenSandbox/E2B dump.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §5.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md) (`opensandbox-group/OpenSandbox`
+ `e2b-dev/E2B` Apache-2.0 **pattern** — `getHost` / preview URL).
Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Service | `backend/src/services/agentes-coding/preview/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/preview` — expose |
| HTTP | `GET …/preview` · `GET …/ports` — list |
| HTTP | `GET …/preview/:token` — resolve signed URL (JSON or HTML stub) |
| HTTP | `DELETE …/preview/:port` · `DELETE …/ports/:port` — unexpose |
| Compat | `POST …/expose` — same as preview expose |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A later iframe
on the Phase 3a shell can point at `GET …/preview/:token` (`Accept:
text/html`) once a UI-lock exception exists. This PR does not add that pane.

Deny-by-default: host allowlist does **not** grant `exposePort`. A port
must be on `previewPorts` / `AGENTES_CODING_PREVIEW_PORTS` or a network
hook must approve `action === 'exposePort'`.

Networking is **injectable**. Memory and docker drivers return localhost
metadata (`127.0.0.1` + `hostPort`) without binding a real socket in CI.
The signed URL is HMAC-SHA256 (`AGENTES_CODING_PREVIEW_SECRET` or a
process-local generated secret). TTL default 10 min
(`AGENTES_CODING_PREVIEW_TTL_MS`). Max 8 ports per session.

## Contract

Expose (auth):

```json
{
  "ok": true,
  "exposed": {
    "port": 5173,
    "published": true,
    "url": "/api/agentes-coding/sessions/csb_…/preview/<token>",
    "host": "127.0.0.1",
    "hostPort": 5173,
    "expiresAt": 1710000000000,
    "driver": "memory"
  }
}
```

`GET …/preview/:token` with a valid signature returns `{ ok, preview }`
or, when `Accept: text/html`, a Spanish stub page (CSP `default-src
'none'`). The token is the credential. Flag off → 404 `not_found`.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PORT_DENIED` `E_PREVIEW_EXPIRED`
`E_PREVIEW_FAILED` `E_SESSION_NOT_FOUND` `E_QUOTA` plus the sandbox
catalog (`docs/agentes-coding-sandbox.md`).

## Out of scope

Enabling the flag on Lenovo, Daytona, a real HTTP reverse-proxy to the
container, reviving `/code`, dumping OpenSandbox/E2B, adding an iframe
to `/agentes` (UI-lock).

## Tests

```bash
cd backend && node --test tests/agentes-coding-preview.test.js
```
