# /agentes — «dame la web en local» (preview del repo desde el chat)

Desde el chat de /agentes el agente puede clonar un repositorio de GitHub y
levantarlo en el runner aislado (`iliagpt-runner`), devolviendo una URL de
preview tokenizada. Antes esto solo existía detrás de botones del IDE
(`AGENTES_CODING_V2`, apagado en producción).

El preloop determinista de `runAgenticChat` intercepta
`isGithubLocalPreviewRequest` (github.com + «dame la web en local» / «en local
5000») **antes** del LLM: llama `project_clone_repo` y `project_preview_start`
en el servidor. No le pide al usuario clonar en su teléfono ni responde
«no puedo abrir el puerto 5000». Un puerto pedido (p. ej. 5000) se pasa como
`preferredPort` al runner; si el pool asigna otro, la respuesta explica la
URL de preview. Este camino **no** exige `AGENTES_CODING_V2`. El gate de
acceso sigue siendo `canUseCodexAgent` (admin / allowlist /
`CODEX_AGENT_OPEN_TO_ALL`).

## Tools del agente (`backend/src/services/agents/project-preview-tools.js`)

| Tool | Qué hace |
|------|----------|
| `project_clone_repo { repoUrl, branch?, name? }` | Clona `https://github.com/owner/repo` en el proyecto Codex ligado al chat (uno por chat; si ya existe se reutiliza). Repos privados usan el GitHub conectado del usuario (Apps → GitHub); sin él → `github_auth_required`. |
| `project_preview_start { preferredPort?, env?, waitMs? }` | Instala según el lockfile (`package-lock.json` → `npm ci`, luego `--ignore-scripts`, luego `npm install`; `bun.lock`/sin lock → `bun install`) y arranca el dev server (Next / Vite / `npm run dev`) en el runner. Espera hasta `waitMs` (90 s por defecto, máx. 150 s). Si sigue instalando devuelve **`preview_pending`** (no es error): el agente avisa y consulta `project_preview_status` después. `preferredPort` (p. ej. 5000) se fija en el runner si está libre. `env` solo admite `NEXT_PUBLIC_*`/`VITE_*`/`PUBLIC_*`/`REACT_APP_*` (p. ej. `NEXT_PUBLIC_API_URL=/api` para que un frontend full-stack hable con la API de producción por el mismo origen). Devuelve `previewUrl` absoluta. |
| `project_preview_status { waitMs? }` | Estado (`installing / building / starting / ready / error`) + últimas líneas de log + `previewUrl`. Con `waitMs` espera a que quede listo tras un `preview_pending`. |
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

## Repos grandes (SiraGPT-APP)

`bun install` no sirve para SiraGPT-APP (lockfile npm con `overrides` anidados y
scripts nativos) y `npm ci` en frío tarda ~8 min. Por eso el instalador se elige
por lockfile, el timeout de instalación es de 15 min (`CODE_RUNNER_INSTALL_TIMEOUT_MS`),
los límites por proceso del sandbox son 8192 fd / 512 procesos
(`CODE_RUNNER_RLIMIT_NOFILE` / `CODE_RUNNER_RLIMIT_NPROC`; con 256 fd `npm ci`
moría con `EMFILE`) y el tool devuelve `preview_pending` mientras instala. El
workspace persiste por proyecto: solo la primera vez es lenta. Un full-stack como
SiraGPT-APP levanta su **frontend** en el runner; su backend (puerto 5000 real,
Postgres, Redis) no cabe en el sandbox, así que el frontend se apunta a la API de
producción con `env: { NEXT_PUBLIC_API_URL: "/api" }` (mismo origen, cookies del
propio usuario).

RLCD: un preview listo registra `tool_success` para las decisiones del turno
(carril agéntico, modelo…); un fallo duro registra `failure`; `preview_pending`
no cuenta.

## Runner (compose)

- `CODE_RUNNER_BUILD_PREFLIGHT=0`: un preview de desarrollo no necesita
  `npm run build`; además `next build` lanza un worker por CPU y con
  `pids_limit: 512` moría con `spawn EAGAIN`.
- `pids_limit: 2048`.
- `CODE_RUNNER_PREVIEW_ALLOWED_ORIGINS=siragpt.com,www.siragpt.com`.
- `CODE_RUNNER_INSTALL_TIMEOUT_MS=900000`, `CODE_RUNNER_RLIMIT_NOFILE=8192`, `CODE_RUNNER_RLIMIT_NPROC=512`.

Puerto: lo asigna el pool del runner (`CODE_RUNNER_DEV_PORT_POOL`); un puerto
pedido por el usuario (p. ej. 5000) no se puede fijar — la URL de preview es
su «web en local».

## Verificar en prod

Dentro de `iliagpt-backend` (ver receta en memoria): `cloneRepoForChat` +
`startPreviewForChat` con un repo público Next (`infosiragpt-ops/dolarnet`)
debe devolver `ok:true` y `status.ready:true` en < 90 s; `GET <basePath>` en
`http://127.0.0.1:5000` responde 308 → 200 con assets bajo el prefijo.
