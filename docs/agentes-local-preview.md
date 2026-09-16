# /agentes — «dame la web en local» (preview del repo desde el chat)

Desde el chat de /agentes el agente puede clonar un repositorio de GitHub y
levantarlo en el runner aislado (`iliagpt-runner`), devolviendo una URL de
preview tokenizada. Antes esto solo existía detrás de botones del IDE
(`AGENTES_CODING_V2`, apagado en producción).

## Tools del agente (`backend/src/services/agents/project-preview-tools.js`)

| Tool | Qué hace |
|------|----------|
| `project_clone_repo { repoUrl, branch?, name? }` | Clona `https://github.com/owner/repo` en el proyecto Codex ligado al chat (uno por chat; si ya existe se reutiliza). Repos privados usan el GitHub conectado del usuario (Apps → GitHub); sin él → `github_auth_required`. |
| `project_preview_start` | `bun install` + dev server (Next / Vite / `npm run dev`) en el runner y espera hasta `CODEX_PREVIEW_START_TIMEOUT_MS` (90 s). Devuelve `previewUrl` absoluta (`https://siragpt.com/api/codex/projects/:id/preview/:token/app/`). Reutiliza un servidor vivo. |
| `project_preview_status` | Estado (`installing / starting / ready / error`) + últimas líneas de log + `previewUrl`. |
| `project_preview_stop` | Para el dev server. |

La lógica vive en `backend/src/services/codex/chat-preview.service.js` y es la
misma que `POST /api/codex/projects/clone` y `POST /api/codex/projects/:id/preview/start`.
Los tools nunca lanzan: devuelven `{ ok:false, code, message }`.

Acceso: el gate del agente de código (`codex/access-control.canUseCodexAgent`):
admin/super-admin, o `CODEX_AGENT_ALLOWED_USER_IDS` (lista de ids), o
`CODEX_AGENT_OPEN_TO_ALL` con aislamiento atestado. Sin acceso → `codex_forbidden`
con el mensaje para el usuario.

## Next.js bajo basePath tokenizado

Vite recibe `--base`; Next solo lee `basePath` de `next.config.*` y su bundler
de desarrollo relee ese archivo (pasar `conf` a `next()` no afecta al routing).
El runner escribe un `next.config.js` (marcador `SIRAGPT_NEXT_PREVIEW_WRAPPER`)
que importa la config del proyecto (`.ts` vía `transpileConfig` de Next, `.mjs`
vía `import()`, `.js/.cjs` vía `require`) y añade `basePath`, `assetPrefix` y
`allowedDevOrigins`. Si el proyecto ya tiene `next.config.js`, se mueve a
`next.config.siragpt-user.js`. Ambos nombres se añaden a `.git/info/exclude`.
Helpers puros en `scripts/code-runner-utils.js` (`planNextPreviewConfig`,
`buildNextPreviewWrapper`); test `backend/tests/code-runner-next-preview.test.js`.

## Runner (compose)

- `CODE_RUNNER_BUILD_PREFLIGHT=0`: un preview de desarrollo no necesita
  `npm run build`; además `next build` lanza un worker por CPU y con
  `pids_limit: 512` moría con `spawn EAGAIN`.
- `pids_limit: 2048`.
- `CODE_RUNNER_PREVIEW_ALLOWED_ORIGINS=siragpt.com,www.siragpt.com`.

Puerto: lo asigna el pool del runner (`CODE_RUNNER_DEV_PORT_POOL`); un puerto
pedido por el usuario (p. ej. 5000) no se puede fijar — la URL de preview es
su «web en local».

## Verificar en prod

Dentro de `iliagpt-backend` (ver receta en memoria): `cloneRepoForChat` +
`startPreviewForChat` con un repo público Next (`infosiragpt-ops/dolarnet`)
debe devolver `ok:true` y `status.ready:true` en < 90 s; `GET <basePath>` en
`http://127.0.0.1:5000` responde 308 → 200 con assets bajo el prefijo.
