# Feature 03 — Provisioning y rutas de proyectos

**Fase:** F1 · **Depende de:** 01, 02 · **Plan TDD:** `docs/superpowers/plans/2026-06-12-codex-agent-v2-f1-foundations.md` Tasks 6–11

## Descripción

La cara HTTP de F1: crear un proyecto provisiona su workspace (starter determinista + git init + commit inicial) y deja el preview disponible on-demand. Cuatro capas testeables por separado: cliente HTTP del runner → starter determinista → orquestación de provisioning → servicio de proyectos → rutas `/api/codex` gated por flag.

## Requisitos

1. **Cliente del runner** (`backend/src/services/codex/runner-client.js`): `createRunnerClient({ fetchImpl, baseUrl, timeoutMs })` con métodos `initWorkspace`, `writeFiles`, `readFile` (query URL-encoded), `exec`, `startDev`, `devStatus`, `stopDev`. HTTP no-2xx o fallo de red → `RunnerError` (con `status`, `body`; red → status 0); `exitCode≠0` viaja como dato. Env: `CODE_RUNNER_URL` (default `http://runner:4097`), `CODE_RUNNER_DEV_URL` (default `http://localhost:5173`). API keys jamás en payloads.
2. **Starter determinista** (`codex/starter-files.js`): mismo input → bytes idénticos. Emite `package.json` (vite ^7, script dev), `index.html` (página "Workspace listo" con el nombre del proyecto), `src/main.js`, `.gitignore`. Nombre HTML-escapado (anti-inyección), cap 80 chars, fallback "Proyecto Codex".
3. **Provisioning** (`codex/workspace.js`): `provisionWorkspace({ project, projectName, runner })` = init → write starter → `gitCommitAll` (add -A, commit con identidad `-c user.name=Codex Agent -c user.email=codex@siragpt.local`, rev-parse) → `{ workspacePath: "projects/<id>", commitSha }`. `gitCommitAll` se exporta (lo reutiliza la feature 07). exitCode≠0 → excepción con etiqueta y stderr.
4. **Servicio** (`codex/project-service.js`): `createProject` persiste fila `provisioning`, provisiona, y actualiza a `ready` (workspacePath + previewUrl) o `error` (mensaje cap 2000) **sin lanzar**. `listProjects` (orden updatedAt desc, take 50) y `getProject` **scoped por userId**. Proyección pública sin userId/jobId. DB y runner inyectables; Prisma por defecto desde `../../config/database` con try/catch.
5. **Rutas** (`backend/src/routes/codex.js`, montado en `backend/index.js` junto a builder):
   - `GET /health` → `{ ok, enabled }` — público y SIEMPRE 200 (el frontend decide la UI V2 con esto).
   - Middleware: flag off → 404 `not_found` para todo lo demás.
   - `POST /projects` (auth, name 1–80 validado) → 201 `{ project }`; `GET /projects`; `GET /projects/:id` (404 ajeno).
   - `POST /projects/:id/preview/start|stop`, `GET /projects/:id/preview/status` — ownership gate + proxy al runner + `devUrl`; runner caído → 502 `runner_unreachable`.

## Pasos técnicos

Plan TDD Tasks 6–11 (tests y código exactos allí): cliente con fetch falso (6 tests) → starter (4) → workspace con runner falso (3) → project-service con DB falsa (3) → contract tests de rutas con `mockResolvedModule` estilo `builder-route.test.js` (6) → mount + smoke de carga → gates finales (suite completa, lint, tsc, rebase, push, `gh run watch`).

## Criterios de aceptación

- [ ] Los 5 archivos de test nuevos verdes y registrados en `backend/package.json`.
- [ ] Flag off: `POST /api/codex/projects` → 404; `GET /api/codex/health` → 200 `{ enabled: false }`. Flag on: health `{ enabled: true }`.
- [ ] Crear proyecto con runner sano → fila `ready` con `workspacePath` y `previewUrl`; con runner caído → fila `error` persistida y respuesta 201 con `status: "error"` (sin 500).
- [ ] Un usuario no puede ver ni operar proyectos de otro (404 en get/preview).
- [ ] `node -e "require('./src/routes/codex')"` carga sin DB/Redis.
- [ ] CI completa en verde tras el push (cierre de la fase F1).
