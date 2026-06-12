# Feature 02 — Workspace API del runner

**Fase:** F1 · **Depende de:** 01 · **Plan TDD:** `docs/superpowers/plans/2026-06-12-codex-agent-v2-f1-foundations.md` Tasks 3–5

## Descripción

El runner Bun (`scripts/code-runner.js`, contenedor `runner`, volumen `opencode_workspace`) es el único proceso con filesystem del sandbox. Se extiende con una API de workspace **por proyecto** (subdirectorios `projects/<id>`) con git, escritura/lectura de archivos y ejecución de comandos con allowlist — la base física de provisioning (feature 03), del loop del agente (06) y de los checkpoints (07).

## Requisitos

1. **Helpers puros** en `scripts/code-runner-utils.js` (sin APIs Bun/Node, requeribles desde los tests del backend):
   - `sanitizeProjectId(raw)` → `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` o `null`.
   - `resolveProjectRelPath(p)` → normaliza `\` → `/`, colapsa `.`/vacíos, **rechaza** `..`, absolutos y unidades Windows; o `null`.
   - `isAllowedCommand(cmd)` → array de strings cuyo primer elemento ∈ `ALLOWED_BINS` = {git, bun, bunx, node, ls, cat, wc}. `sh -c` y `rm` quedan fuera por diseño.
2. **Endpoints nuevos** en el control API del runner (puerto interno 4097, nunca publicado al host):
   - `POST /workspace/init { project }` → mkdir recursivo + `git init -b main`; 400 id inválido, 500 con detail si git falla.
   - `POST /workspace/write { project, files[] }` → escribe hasta 200 archivos (cap 2MB c/u), paths sanitizados, crea directorios; → `{ ok, written }`; 404 si el proyecto no existe.
   - `GET /workspace/file?project&path` → contenido (cap 200k); 404 si no existe.
   - `POST /workspace/exec { project, cmd[], timeoutMs }` → spawn en el dir del proyecto con timeout clamp [1s, 120s]; → `{ ok, exitCode, stdout, stderr, durationMs }` (caps 30k). **HTTP 200 con exitCode≠0**: el fallo del comando es dato, no error de transporte. 400 comando fuera de allowlist.
3. **`POST /run` acepta `{ project }`** (opcional, backward-compatible: sin body sigue corriendo el workspace raíz). `startDev(projectId)` usa el cwd del proyecto y registra `state.project`, visible en `/status`.
4. **Git confiable en el volumen compartido:** al boot, `git config --global --add safe.directory '*'` (try/catch — si git falta lo reporta `/workspace/init`).
5. **Compose:** ambos scripts montados lado a lado en `/scripts/` (el `require("./code-runner-utils.js")` resuelve relativo al entry); `command: ["bun", "/scripts/code-runner.js"]`.
6. **Git en la imagen:** verificar `docker run --rm oven/bun:1 git --version`; si falta, `scripts/runner.Dockerfile` (FROM oven/bun:1 + apt-get install git) y el servicio pasa de `image:` a `build:`.

## Pasos técnicos

Plan TDD Tasks 3–5 (código exacto incluido allí):
1. Tests de los helpers puros (`backend/tests/codex-runner-utils.test.js`) → implementación → registro en package.json.
2. Patch de `code-runner.js`: imports + `PROJECTS_DIR` + safe.directory, `state.project`, `startDev(projectId)`, 4 handlers nuevos, `/run` con body.
3. Mounts de compose; verificación manual con curl si Docker está disponible (4097 es interno: curl desde el contenedor backend o mapping temporal).
4. Dockerfile condicional del runner.

## Criterios de aceptación

- [ ] Tests de utils verdes: ids cuid-like aceptados; `../etc`, espacios, >64 chars rechazados; traversal/absolutos/`C:` bloqueados; `rm`/`sh` bloqueados, formato no-array bloqueado.
- [ ] `POST /workspace/init` con id inválido → 400; con git ausente → 500 `git_init_failed` con detail.
- [ ] `exec` jamás corre un binario fuera de la allowlist y siempre responde dentro del timeout clampado.
- [ ] `POST /run` sin body se comporta exactamente como antes (flujo /code actual intacto).
- [ ] Smoke manual (si hay Docker): init → `{ ok, dir: "projects/<id>" }`; write + `exec ["git","status"]` → exitCode 0.
- [ ] Suite completa + lint verdes.
