# Session export + deploy stubs (AGENTES_CODING_V2 Phase 3g)

Zip/tarball **export** of a jailed coding-sandbox workspace, plus a
**deploy stub** that records intent and optionally talks to a
Coolify/Dokploy-style HTTP API through an **injectable client**.
Default **OFF**. Canonical UI stays `/agentes`.

This is not a `/code` revival, not F7 / SiraComputer, not Daytona, and
not a dump of Coolify or Dokploy.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §11.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md)
(`coollabsio/coolify` Apache-2.0 + `Dokploy/dokploy` Apache-2.0 —
**external API only**). Sessions:
[`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Export | `backend/src/services/agentes-coding/export/` |
| Deploy | `backend/src/services/agentes-coding/deploy/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/export` |
| HTTP | `GET …/export` · `GET …/export/:exportId` |
| HTTP | `POST /api/agentes-coding/sessions/:id/deploy` |
| HTTP | `GET …/deploy` · `GET …/deploy/:deployId` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A later
download button can point at `GET …/export/:id?download=1` once a
UI-lock exception exists.

## Export

POST (auth) builds a STORE zip or `tar.gz` of files already inside the
session jail (`jailRelPath` / `/workspace`). `.git/` is skipped. Size
caps: `AGENTES_CODING_EXPORT_MAX_BYTES` (default 8 MiB) and
`AGENTES_CODING_EXPORT_MAX_FILES` (default 256). The archive stays
in-process on the session; the JSON returns metadata + a jailed
`artifactPath` (`.sira/exports/exp_….zip`). No monorepo dump.

```json
{
  "ok": true,
  "export": {
    "id": "exp_…",
    "format": "zip",
    "bytes": 1234,
    "sha256": "64-hex",
    "fileCount": 2,
    "files": [{ "path": "src/app.ts", "size": 20 }],
    "artifactPath": ".sira/exports/exp_….zip",
    "createdAt": 1710000000000
  }
}
```

`path` (optional) filters to a subdirectory. `../` and host-absolute
paths are `E_PATH_ESCAPE`. `GET …/export/:id?download=1` streams the
bytes; default GET is JSON metadata.

## Deploy

Default POST **records intent** and returns Spanish status
`registrado`. It does **not** call Coolify or Dokploy.

A live call happens only when `live: true` (or `provider` is
`coolify`/`dokploy` **and** `baseUrl` is set) **and** all of:

1. Injectable HTTP client (`createAgentesCodingRouter({ deployHttp })`)
2. `baseUrl` origin is on `AGENTES_CODING_DEPLOY_BASE_URLS` (or
   `AGENTES_CODING_DEPLOY_BASE_URL`)
3. Token, if any, comes from env (`AGENTES_CODING_DEPLOY_TOKEN`,
   `COOLIFY_TOKEN`, `DOKPLOY_TOKEN`) or a test-injected `token` —
   never hardcoded, never echoed

Request shapes (external API only, no source copy):

- Coolify: `POST {origin}/api/v1/deploy` + `Authorization: Bearer`
- Dokploy: `POST {origin}/api/application.deploy` + `x-api-key`

Responses redact headers. Missing allowlist or client →
`E_DEPLOY_DENIED`.

```json
{
  "ok": true,
  "deploy": {
    "id": "dep_…",
    "status": "registrado",
    "message": "Intención de despliegue registrada. No se llamó a un proveedor externo.",
    "provider": "stub",
    "name": "proyecto",
    "recordedAt": 1710000000000,
    "live": false
  }
}
```

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PATH_ESCAPE` `E_QUOTA`
`E_EXPORT_FAILED` `E_EXPORT_NOT_FOUND` `E_DEPLOY_DENIED`
`E_DEPLOY_FAILED` `E_DEPLOY_NOT_FOUND` `E_SESSION_NOT_FOUND`
`E_TIMEOUT` plus the sandbox catalog
(`docs/agentes-coding-sandbox.md`).

## Out of scope

Enabling the flag on Lenovo, calling a real Coolify/Dokploy from CI,
Daytona, reviving `/code`, dumping those monorepos, export/deploy UI
on `/agentes` (UI-lock).

## Tests

```bash
cd backend && node --test tests/agentes-coding-export-deploy.test.js
```
