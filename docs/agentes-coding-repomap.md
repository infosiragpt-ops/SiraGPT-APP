# Repo-map hints (AGENTES_CODING_V2 Phase 3b)

Internal **Aider-pattern** ranked file/symbol hints for a coding-sandbox
session. Default **OFF**. Canonical UI stays `/agentes`. This is not a
`/code` revival, not a dump of `aider-ai/aider`, and not a tree-sitter
monorepo vendor.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md) (`aider-ai/aider`
Apache-2.0, **pattern only**). Sessions: [`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Service | `backend/src/services/agentes-coding/repo-map/` |
| HTTP | `GET|POST /api/agentes-coding/sessions/:id/map` — **404** unless the flag is on |
| IDE hook | `repoMap()` in `lib/agentes-coding/api.ts` + **Mapa** on the file tree (only when the IDE already mounted) |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo.

## Contract

Input: a sandbox `sessionId` (HTTP) or a workspace root / path list
(internal / tests).

Output (no whole-file load):

```json
{
  "ok": true,
  "hints": [{ "name": "Header", "path": "src/components/Header.tsx", "kind": "fn", "score": 0.82 }],
  "omitted": 0,
  "scanned": 6,
  "headerBytes": 8192
}
```

Ranking: import graph → damped PageRank-lite + path/frequency heuristics
(entrypoints, `src/`, query match). Symbols come from the **first 8 KiB**
of each source file (regex). Tree-sitter is an optional `parseTags`
hook — not a dependency.

Skip: `node_modules`, `dist`, `build`, `.next`, `.git`, `coverage`,
`.sira`, `vendor`, `__pycache__`.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_SESSION_NOT_FOUND`
`E_SESSION_EXPIRED` `E_PATH_ESCAPE` `E_MAP_FAILED` plus the sandbox
catalog (`docs/agentes-coding-sandbox.md`).

## Out of scope

Dumping Aider, enabling the flag on Lenovo, AGPL sandboxes, reviving
`/code`, vendoring tree-sitter grammars.

## Tests

```bash
cd backend && node --test tests/agentes-coding-repo-map.test.js
```
