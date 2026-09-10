# CONSTRUIR coding MVP (`/agentes`)

Functional coding path that **does not require** `AGENTES_CODING_V2`.
Luis can program a small web/app from `siragpt.com/agentes`, download real
code, and (if GitHub OAuth is connected) publish a repo.

## Flag OFF vs ON

| Surface | `AGENTES_CODING_V2` OFF (prod default) | ON (non-production only) |
|---|---|---|
| «créame una web/app» on `/agentes` | Works. `webdev` → HTML preview + `.html` + `.zip` (Node + file DB) | Same, plus IDE shell |
| Preview / download | HTML in the chat + artifact download URLs | Same + IDE preview pane |
| GitHub | `github_publish_project` / `POST /api/construir-mvp/github` using the user's OAuth | Same |
| Isolated sandbox IDE | Hidden (`/api/agentes-coding/*` 404 except `/health`) | Gated IDE |

Do **not** set `AGENTES_CODING_V2=1` on the Lenovo origin from this PR.
Enable it later only if you want the experimental IDE.

## How Luis tries it

1. Open https://siragpt.com/agentes (after publish of this SHA).
2. Pick a model in the existing picker (`Sira Rápido`, `Sira Pro`, or another catalog label). Raw vendor ids are never shown.
3. Write: **«créame una web de ventas»** or **«créame una app de notas»**.
4. You should get:
   - previewable HTML in the message (not a `.docx`)
   - download links for the page and a `.zip` project
5. Unzip and run locally (no prod DB):

   ```bash
   node server.js
   ```

   → http://127.0.0.1:5173 — data lives in `data/app.json`.
6. GitHub:
   - Connect the account at `/conexiones`.
   - Then: **«súbelo a GitHub»**.
   - If it is not connected, the tool returns a Spanish error with that CTA. No tokens are invented.

## API (Bearer session, same as the rest of `/api`)

- `GET /api/construir-mvp/health` → `{ ok, enabled: true, flagRequired: false, agentesCodingV2 }`
- `POST /api/construir-mvp` `{ prompt, chatId?, modelAlias?, publishGithub?, approved?, repoName? }`
- `POST /api/construir-mvp/github` `{ chatId?, repoName?, branch?, approved: true }`

## Database

The scaffold uses a **file JSON DB** (`lib/db.js` → `data/app.json`) so the
demo never touches production Postgres. A local Postgres is optional and
must stay on `127.0.0.1` — see the generated README.

## Agent tools

- `construir_scaffold` — pinned on software-build turns (also used from generate-webdev)
- `github_publish_project` — write, requires `approved=true` + user OAuth
