# CONSTRUIR · GitHub repo → PR (`/agentes`)

Claude-Code-shaped slice on top of the CONSTRUIR MVP: Luis connects
GitHub, the agent opens a repo he owns (or can access) in an **isolated
workspace**, edits it, and opens a Pull Request with **his** OAuth token.

Does **not** require `AGENTES_CODING_V2`. Production (`NODE_ENV=production`)
keeps that flag forced off. The sandbox IDE stays gated; this path uses
chat tools + `/api/construir-mvp/repo/*`.

## Flag OFF vs ON

| Surface | `AGENTES_CODING_V2` OFF (prod default) | ON (non-production only) |
|---|---|---|
| «abre un PR en owner/repo que…» | Works. OAuth clone via GitHub API → isolated workspace → PR | Same |
| Isolated sandbox IDE | Hidden (`/api/agentes-coding/*` 404 except `/health`) | Gated IDE |
| Host `.env` | Never read. Workspace is a jailed file map | Same |

Do **not** set `AGENTES_CODING_V2=1` on the Lenovo origin from this PR.

## How Luis tries it on https://siragpt.com/agentes

1. Open **Conexiones** (`/conexiones`) and connect GitHub (OAuth `repo` + `read:user`).
2. Back on `/agentes`, pick a catalog label (`Sira Rápido`, `Sira Pro`, or another picker name). Raw vendor / `model_id` are never shown.
3. Write something like:

   **«abre un PR en owner/repo que añada un README con instrucciones de arranque»**

   Replace `owner/repo` with a repository your GitHub user can push to.
4. The agent should:
   - open the repo in an isolated workspace (`github_open_repo`)
   - list / read / write / exec inside that jail
   - create a branch (never `main`), commit, and open a Pull Request
   - return the **PR URL** in the chat (and a small markdown artifact)
5. If GitHub is not connected, the tool answers in Spanish and points to
   `/conexiones`. Sira never invents a token.

Greenfield «créame una web» still uses `construir_scaffold` +
`github_publish_project` (`docs/construir-mvp.md`). This slice is for an
**existing** repo + Pull Request.

## Agent tools (always registered; pinned on PR-intent turns)

| Tool | Role |
|---|---|
| `github_open_repo` | OAuth-scoped open into the isolated workspace |
| `github_repo_list` / `github_repo_read` / `github_repo_write` / `github_repo_exec` | Coding loop in the jail (`ls` / `cat` / `pwd` builtin; no host env) |
| `github_open_pull_request` | Branch + commit + PR. Requires `approved=true` |

## API (Bearer session)

- `POST /api/construir-mvp/repo/open` `{ owner?, repo, ref?, chatId?, modelAlias? }`
- `POST /api/construir-mvp/repo/list|read|write|exec`
- `POST /api/construir-mvp/repo/pr` `{ title, body?, branch?, base?, approved: true, chatId? }`
- `GET /api/construir-mvp/health` → `githubPrFlow: true`, `flagRequired: false`

## Safety

- Token only in the `Authorization` header. Never in URLs, logs, or tool results.
- Path jail: no `..`, no absolute paths, no host `.env`.
- `.env` / key files from the remote tree are skipped.
- Exec has no `process.env` (sanitized `PATH`/`HOME`/`LANG` only).
- Work branch is rewritten if it would be `main` / `master`.
