# Session git checkpoints (AGENTES_CODING_V2 Phase 3f)

Per-session **git init / status / diff / commit-checkpoint** inside a
coding-sandbox workspace. Default **OFF**. Canonical UI stays `/agentes`.
This is not a `/code` revival, not F7 / SiraComputer, and not a dump of
`isomorphic-git` or `simple-git`.

Architecture: [`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) §6.
Catalog: [`docs/oss-catalog.md`](./oss-catalog.md)
(`isomorphic-git/isomorphic-git` MIT + `steveukx/git-js` MIT — **pattern
only**: in-process store + argv-only runner). Sessions:
[`docs/agentes-coding-sandbox.md`](./agentes-coding-sandbox.md).

## What this PR adds

| Piece | Path |
|---|---|
| Service | `backend/src/services/agentes-coding/git/` |
| HTTP | `POST /api/agentes-coding/sessions/:id/git/init` |
| HTTP | `GET …/git/status` · `GET …/git/diff` |
| HTTP | `POST …/git/checkpoint` — commit a snapshot |
| HTTP | `GET …/git/checkpoints` · `GET …/git/checkpoints/:sha` |

`GET /api/agentes-coding/health` stays `{ ok, enabled }`. Flag stays **off**
on Lenovo. Do not set `AGENTES_CODING_V2=1` on the origin from this PR.

**API-only** (no new `/agentes` chrome; UI-lock unchanged). A later IDE
timeline can list checkpoints once a UI-lock exception exists.

CI injects a git runner (argv array, never a shell string). The default
path is an in-process store on the session object — no host `git` binary,
no npm dep. Paths stay jailed (`jailRelPath` / `/workspace`).

## Contract

Init (auth):

```json
{ "ok": true, "initialized": true, "already": false, "branch": "main" }
```

Status:

```json
{
  "ok": true,
  "initialized": true,
  "branch": "main",
  "clean": false,
  "files": [{ "path": "src/app.ts", "status": "??" }]
}
```

Checkpoint:

```json
{
  "ok": true,
  "checkpoint": {
    "sha": "40-hex",
    "message": "punto inicial",
    "createdAt": 1710000000000,
    "filesChanged": 2
  }
}
```

`GET …/git/diff` returns `{ ok, patch, files }`. `path` / `from` / `to`
are optional. `../` and absolute host paths are `E_PATH_ESCAPE`.

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_PATH_ESCAPE` `E_GIT_FAILED`
`E_CHECKPOINT_NOT_FOUND` `E_SESSION_NOT_FOUND` `E_TIMEOUT` `E_QUOTA`
plus the sandbox catalog (`docs/agentes-coding-sandbox.md`).

## Out of scope

Adding `isomorphic-git` / `simple-git` npm, enabling the flag on Lenovo,
Daytona, reviving `/code`, dumping those monorepos, git UI on `/agentes`
(UI-lock).

## Tests

```bash
cd backend && node --test tests/agentes-coding-git.test.js
```
