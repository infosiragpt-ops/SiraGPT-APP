# Structural edit via ast-grep patterns (AGENTES_CODING_V2 Phase 3c)

Internal **ast-grep-pattern** search/replace for a coding-sandbox
session. Default **OFF**. Canonical UI stays `/agentes`. This is not a
`/code` revival, not a dump of `ast-grep/ast-grep`, and not an AGPL
sandbox.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md) (`ast-grep/ast-grep`
MIT, **pattern only** — thin Node wrapper + injectable `sg` exec).
Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Service | `backend/src/services/agentes-coding/structural-edit/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/struct-edit` — preview |
| HTTP | `POST /api/agentes-coding/sessions/:id/struct-edit/apply` — write via `writeFile` |
| IDE hook | `structEditPreview` / `structEditApply` on `lib/agentes-coding/api.ts` (no new chrome) |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

The wrapper prefers the `sg` / `ast-grep` binary when present
(`AGENTES_CODING_SG_BIN` or `PATH`). CI injects a runner — no binary
required. The CLI is **never** invoked with `--update-all`.

## Contract

Preview (no write):

```json
{
  "ok": true,
  "matches": [{ "path": "src/log.ts", "text": "console.log(name)", "replacement": "logger.info(name)" }],
  "diffs": [{ "path": "src/log.ts", "original": "…", "proposed": "…", "changed": true, "matchCount": 2 }],
  "scanned": 2,
  "lang": "typescript"
}
```

Apply: explicit `diffs` (or a second pattern+rewrite pass) →
`sandbox.writeFile` after `jailRelPath`. Stale `original` → `E_CONTENT`.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PATH_ESCAPE` `E_STRUCT_EDIT_FAILED`
`E_CONTENT` `E_TIMEOUT` `E_QUOTA` plus the sandbox catalog
(`docs/agentes-coding-sandbox.md`).

## Out of scope

Dumping ast-grep, enabling the flag on Lenovo, AGPL sandboxes, reviving
`/code`, installing `sg` on the Lenovo image from this PR.

## Tests

```bash
cd backend && node --test tests/agentes-coding-structural-edit.test.js
```
