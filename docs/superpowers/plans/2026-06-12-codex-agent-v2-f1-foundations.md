# Codex Agent V2 — F1 Fundaciones · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fase F1 del spec `docs/codex-agent-ux.md`: migración Prisma `codex_*`, flag `CODEX_AGENT_V2`, API de workspace en el runner (directorios por proyecto + git + exec), y rutas `/api/codex` con provisioning de proyectos (workspace + git init + commit inicial + preview on-demand).

**Architecture:** El runner Bun (`scripts/code-runner.js`, contenedor `runner` en docker-compose, volumen compartido `opencode_workspace`) se extiende con una API de workspace por proyecto (`/workspace/init|write|file|exec`) — es el único proceso con acceso al filesystem del sandbox, así que git y los comandos del agente corren ahí, nunca en el backend. El backend agrega un cliente HTTP tipado del runner, un servicio de provisioning y rutas `/api/codex` gated por flag (flag off → 404, salvo `/health`). Capas testeables por separado: utils puros del runner → cliente con fetch mockeado → servicios con cliente falso → rutas con servicios stubbeados (patrón `builder-route.test.js`).

**Tech Stack:** Express + express-validator + `authenticateToken`, Prisma (PostgreSQL, cliente en `backend/src/config/database`), Bun (runner), node:test + supertest (backend/tests), docker-compose perfil `opencode`.

**Restricción heredada (anotar, no resolver en F1):** el runner es single-tenant en el puerto dev 5173 — un solo dev server activo a la vez por despliegue. El workspace por proyecto sí es multi-proyecto (subdirectorios), pero "View preview" apunta siempre al proyecto activo. Documentado en spec §13.

**Convenciones del repo que este plan respeta:**
- Tests backend: `node --test`, archivos en `backend/tests/`, registrados añadiendo la ruta al script `"test"` (una sola línea larga) de `backend/package.json`.
- Stub de módulos en tests: `mockResolvedModule` de `backend/tests/http-test-utils.js` (ver `builder-route.test.js:15-31`).
- Prisma: ids `cuid()`, `@@map` a snake_case, relaciones con back-relation en `User`.
- DB local dockerizada con historial de migraciones drifted → aplicar local con `npx prisma db push`; la carpeta de migración se genera igualmente para prod.
- Commits convencionales, push directo a main con `git pull --rebase` previo, CI verde obligatorio.
- Mensajes de commit terminan con `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Planes posteriores:** F2 (motor BullMQ + SSE persistido), F3 (checkpoints/métricas/costos), F4–F5 (UI), F6 (E2E) se planifican al completar cada fase, contra el código real.

---

## Mapa de archivos

| Acción | Archivo | Responsabilidad |
|---|---|---|
| Create | `backend/src/services/codex/flags.js` | Lectura del flag `CODEX_AGENT_V2` |
| Create | `backend/src/services/codex/runner-client.js` | Cliente HTTP del runner (init/write/file/exec/run/status/stop) |
| Create | `backend/src/services/codex/starter-files.js` | Starter Vite determinista + escape anti-inyección |
| Create | `backend/src/services/codex/workspace.js` | Orquestación de provisioning (init → write → git commit) |
| Create | `backend/src/services/codex/project-service.js` | CRUD de CodexProject + provisioning con manejo de error |
| Create | `backend/src/routes/codex.js` | Rutas `/api/codex/*` gated por flag |
| Create | `scripts/code-runner-utils.js` | Helpers puros: sanitización de ids/paths, allowlist de comandos |
| Create | `backend/prisma/migrations/20260612120000_add_codex_tables/migration.sql` | DDL de las 6 tablas `codex_*` |
| Create | `scripts/runner.Dockerfile` | (Solo si `oven/bun:1` no trae git) imagen runner + git |
| Modify | `backend/prisma/schema.prisma` | 6 modelos Codex + 2 back-relations en `User` |
| Modify | `scripts/code-runner.js` | API de workspace por proyecto + `/run` con `{ project }` |
| Modify | `docker-compose.yml` | Mounts de runner (`/scripts/`) + git en la imagen si hace falta |
| Modify | `backend/index.js` | Require + mount de `/api/codex` |
| Modify | `backend/package.json` | Registro de los 6 archivos de test nuevos |
| Test | `backend/tests/codex-flags.test.js` | Flag on/off |
| Test | `backend/tests/codex-runner-utils.test.js` | Ids, traversal, allowlist |
| Test | `backend/tests/codex-runner-client.test.js` | Contratos HTTP con fetch mockeado |
| Test | `backend/tests/codex-starter-files.test.js` | Determinismo + escape |
| Test | `backend/tests/codex-workspace.test.js` | Orden de provisioning + propagación de fallos |
| Test | `backend/tests/codex-route-contract.test.js` | Flag off → 404, contratos de rutas |

---

### Task 1: Flag `CODEX_AGENT_V2`

**Files:**
- Create: `backend/src/services/codex/flags.js`
- Test: `backend/tests/codex-flags.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCodexV2Enabled } = require('../src/services/codex/flags');

test('disabled by default (empty env)', () => {
  assert.equal(isCodexV2Enabled({}), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '' }), false);
});

test('enabled with 1 / true / on (case-insensitive, trimmed)', () => {
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '1' }), true);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'true' }), true);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: ' ON ' }), true);
});

test('disabled with 0 / false / garbage', () => {
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: '0' }), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'false' }), false);
  assert.equal(isCodexV2Enabled({ CODEX_AGENT_V2: 'yes please' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (cwd `backend/`): `node --test tests/codex-flags.test.js`
Expected: FAIL — `Cannot find module '../src/services/codex/flags'`

- [ ] **Step 3: Write minimal implementation**

`backend/src/services/codex/flags.js`:

```js
'use strict';

/**
 * codex/flags — feature flag CODEX_AGENT_V2 (spec docs/codex-agent-ux.md §10).
 * Flag off ⇒ /api/codex/* responde 404 (salvo /health) y el worker no se registra.
 */

function isCodexV2Enabled(env = process.env) {
  const v = String(env.CODEX_AGENT_V2 || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

module.exports = { isCodexV2Enabled };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-flags.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the test**

In `backend/package.json`, append ` tests/codex-flags.test.js` to the end of the single-line `"test"` script (before the closing quote, space-separated like every other entry).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/codex/flags.js backend/tests/codex-flags.test.js backend/package.json
git commit -m "feat(codex): flag CODEX_AGENT_V2 — gate de la fase F1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Modelos Prisma + migración `codex_*`

**Files:**
- Modify: `backend/prisma/schema.prisma` (final del archivo + bloque `model User`)
- Create: `backend/prisma/migrations/20260612120000_add_codex_tables/migration.sql`

- [ ] **Step 1: Add the six models at the end of `schema.prisma`**

```prisma
// ── Codex Agent V2 (flag CODEX_AGENT_V2) — spec docs/codex-agent-ux.md §4 ──
// Proyectos con workspace git en el runner + corridas server-driven con
// timeline append-only (codex_events) reproducible tras recarga.

model CodexProject {
  id            String   @id @default(cuid())
  userId        String
  name          String
  status        String   @default("provisioning") // provisioning | ready | error
  workspacePath String? // relativo al volumen del runner: projects/<id>
  previewUrl    String?
  brief         Json?
  error         String?  @db.Text
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user        User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  runs        CodexRun[]
  checkpoints CodexCheckpoint[]

  @@index([userId, updatedAt])
  @@map("codex_projects")
}

model CodexRun {
  id         String    @id @default(cuid())
  projectId  String
  userId     String
  mode       String // plan | build
  status     String    @default("queued") // queued | running | waiting_approval | done | error | cancelled
  jobId      String?   @unique
  model      String?
  tier       String?
  planRunId  String?
  error      String?   @db.Text
  createdAt  DateTime  @default(now())
  startedAt  DateTime?
  finishedAt DateTime?
  updatedAt  DateTime  @updatedAt

  user        User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  project     CodexProject      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  events      CodexEvent[]
  actions     CodexAction[]
  checkpoints CodexCheckpoint[]
  metric      CodexRunMetric?

  @@index([projectId, createdAt])
  @@index([userId, status, updatedAt])
  @@map("codex_runs")
}

model CodexEvent {
  id        String   @id @default(cuid())
  runId     String
  seq       Int
  type      String
  payload   Json
  createdAt DateTime @default(now())

  run CodexRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@unique([runId, seq])
  @@index([runId, createdAt])
  @@map("codex_events")
}

model CodexAction {
  id            String   @id @default(cuid())
  runId         String
  kind          String // terminal | file_read | file_write | reasoning | web
  command       String?  @db.Text
  path          String?
  outputSummary String?  @db.Text
  status        String   @default("running") // running | done | error
  durationMs    Int?
  linesRead     Int?
  groupId       String?
  createdAt     DateTime @default(now())

  run CodexRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, createdAt])
  @@map("codex_actions")
}

model CodexCheckpoint {
  id        String   @id @default(cuid())
  runId     String
  projectId String
  commitSha String
  title     String
  createdAt DateTime @default(now())

  run     CodexRun     @relation(fields: [runId], references: [id], onDelete: Cascade)
  project CodexProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, createdAt])
  @@map("codex_checkpoints")
}

model CodexRunMetric {
  id              String   @id @default(cuid())
  runId           String   @unique
  timeWorkedMs    Int      @default(0)
  actionsCount    Int      @default(0)
  itemsReadLines  Int      @default(0)
  additions       Int      @default(0)
  deletions       Int      @default(0)
  tokensIn        Int      @default(0)
  tokensOut       Int      @default(0)
  costUsd         Float    @default(0)
  costSource      String   @default("estimated") // provider_exact | openrouter_generation | estimated
  costOriginalUsd Float    @default(0)
  costAppliedUsd  Float    @default(0)
  createdAt       DateTime @default(now())

  run CodexRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@map("codex_run_metrics")
}
```

- [ ] **Step 2: Add back-relations inside `model User { ... }`**

Add these two lines anywhere in the `model User` body, next to the other relation lists (e.g. near `goalRuns GoalRun[]` if present — `npx prisma format` will align them):

```prisma
  codexProjects CodexProject[]
  codexRuns     CodexRun[]
```

- [ ] **Step 3: Validate and regenerate the client**

Run (cwd `backend/`):
```bash
npx prisma format && npx prisma validate && npx prisma generate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀` + client generated without errors. If `validate` complains about a missing opposite relation, the back-relations of Step 2 are missing or misnamed.

- [ ] **Step 4: Generate the migration SQL**

The local migration history is drifted (see memory/db procedure), so do NOT use `prisma migrate dev`. Generate the full-schema DDL and extract only the `codex_` statements:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > codex-full.sql
```

Create `backend/prisma/migrations/20260612120000_add_codex_tables/migration.sql` and copy into it, **from `codex-full.sql` only**, in this order: the 6 `CREATE TABLE "codex_..."` statements, every `CREATE INDEX`/`CREATE UNIQUE INDEX` on `codex_` tables, and every `ALTER TABLE "codex_..." ADD CONSTRAINT ... FOREIGN KEY` statement. The FK targets (the `User` table's real mapped name) must come from the generated file — do not hand-write them. Delete `codex-full.sql` afterwards (do not commit it).

- [ ] **Step 5: Apply locally (only if the dockerized DB is up)**

```bash
npx prisma db push
```
Expected: `Your database is now in sync with your Prisma schema.` If the local DB isn't running, skip — unit tests in this plan don't touch the DB.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260612120000_add_codex_tables/migration.sql
git commit -m "feat(codex): modelos Prisma codex_* — proyectos, runs, eventos, acciones, checkpoints, métricas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Helpers puros del runner (`code-runner-utils.js`)

**Files:**
- Create: `scripts/code-runner-utils.js`
- Test: `backend/tests/codex-runner-utils.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeProjectId,
  resolveProjectRelPath,
  isAllowedCommand,
} = require('../../scripts/code-runner-utils');

test('sanitizeProjectId accepts cuid-like ids and rejects everything else', () => {
  assert.equal(sanitizeProjectId('cmbx1y2z30000abcd1234efgh'), 'cmbx1y2z30000abcd1234efgh');
  assert.equal(sanitizeProjectId('proj_1-A'), 'proj_1-A');
  assert.equal(sanitizeProjectId('../etc'), null);
  assert.equal(sanitizeProjectId('a b'), null);
  assert.equal(sanitizeProjectId(''), null);
  assert.equal(sanitizeProjectId(null), null);
  assert.equal(sanitizeProjectId('x'.repeat(65)), null);
});

test('resolveProjectRelPath normalizes and blocks traversal/absolute paths', () => {
  assert.equal(resolveProjectRelPath('src/main.js'), 'src/main.js');
  assert.equal(resolveProjectRelPath('./a//b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('a\\b.txt'), 'a/b.txt');
  assert.equal(resolveProjectRelPath('../secret'), null);
  assert.equal(resolveProjectRelPath('a/../../b'), null);
  assert.equal(resolveProjectRelPath('/etc/passwd'), null);
  assert.equal(resolveProjectRelPath('C:/windows'), null);
  assert.equal(resolveProjectRelPath(''), null);
});

test('isAllowedCommand allows git/bun/bunx/node and blocks the rest', () => {
  assert.equal(isAllowedCommand(['git', 'init']), true);
  assert.equal(isAllowedCommand(['bun', 'install']), true);
  assert.equal(isAllowedCommand(['rm', '-rf', '/']), false);
  assert.equal(isAllowedCommand(['sh', '-c', 'echo hi']), false);
  assert.equal(isAllowedCommand([]), false);
  assert.equal(isAllowedCommand('git init'), false);
  assert.equal(isAllowedCommand(['git', 42]), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (cwd `backend/`): `node --test tests/codex-runner-utils.test.js`
Expected: FAIL — `Cannot find module '../../scripts/code-runner-utils'`

- [ ] **Step 3: Write minimal implementation**

`scripts/code-runner-utils.js`:

```js
'use strict';

/**
 * code-runner-utils — pure helpers shared by the runner sidecar and its
 * backend tests. No Bun/Node APIs here: keep it requireable from both.
 */

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Sandbox-internal allowlist: the agent's terminal goes through the runner,
// but only via these binaries (extended deliberately, per phase).
const ALLOWED_BINS = new Set(['git', 'bun', 'bunx', 'node', 'ls', 'cat', 'wc']);

function sanitizeProjectId(raw) {
  const id = String(raw || '').trim();
  return PROJECT_ID_RE.test(id) ? id : null;
}

function resolveProjectRelPath(relPath) {
  const p = String(relPath || '').replaceAll('\\', '/').trim();
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function isAllowedCommand(cmd) {
  return (
    Array.isArray(cmd) &&
    cmd.length > 0 &&
    cmd.every((c) => typeof c === 'string') &&
    ALLOWED_BINS.has(cmd[0])
  );
}

module.exports = { sanitizeProjectId, resolveProjectRelPath, isAllowedCommand, ALLOWED_BINS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-runner-utils.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the test and commit**

Append ` tests/codex-runner-utils.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add scripts/code-runner-utils.js backend/tests/codex-runner-utils.test.js backend/package.json
git commit -m "feat(codex): helpers puros del runner — ids, paths y allowlist de comandos

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: API de workspace en el runner + compose

**Files:**
- Modify: `scripts/code-runner.js`
- Modify: `docker-compose.yml` (servicio `runner`, líneas ~209-231)

El runner no tiene suite automatizada (corre solo bajo Bun en Docker); su lógica con riesgo (ids, paths, allowlist) quedó en los utils ya testeados. La verificación es manual al final de la task.

- [ ] **Step 1: Add imports + project-dir plumbing to `scripts/code-runner.js`**

After line 15 (`*/`), replace the current header block:

```js
const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
const CTRL_PORT = Number(process.env.CTRL_PORT || 4097);
```

with:

```js
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { dirname } = require("node:path");
const { sanitizeProjectId, resolveProjectRelPath, isAllowedCommand } = require("./code-runner-utils.js");

const WORKDIR = process.env.RUNNER_WORKDIR || "/workspace";
const DEV_PORT = Number(process.env.DEV_PORT || 5173);
const CTRL_PORT = Number(process.env.CTRL_PORT || 4097);
const PROJECTS_DIR = `${WORKDIR}/projects`;

function projectDirOf(id) {
  return `${PROJECTS_DIR}/${id}`;
}

// Git refuses repos owned by another uid ("dubious ownership") — the volume
// is shared across containers, so trust it wholesale inside the sandbox.
try {
  Bun.spawnSync(["git", "config", "--global", "--add", "safe.directory", "*"]);
} catch {
  /* git missing — surfaced by /workspace/init instead */
}
```

- [ ] **Step 2: Track the active project in `state` and make `startDev` project-aware**

In the `state` object (line ~22), add `project: null,` after `framework: null,`.

Change `async function startDev() {` (line ~78) to `async function startDev(projectId = null) {`, and immediately after `state.log = [];` add:

```js
  const cwd = projectId ? projectDirOf(projectId) : WORKDIR;
  state.project = projectId;
```

Then replace every workspace-root reference inside `startDev` with `cwd`:
- `readJson(`${WORKDIR}/package.json`)` → `readJson(`${cwd}/package.json`)`
- `Bun.spawn(["bun", "install"], { cwd: WORKDIR, ... })` → `{ cwd, ... }`
- `devProc = Bun.spawn(cmd, { cwd: WORKDIR, ... })` → `{ cwd, ... }`

- [ ] **Step 3: Add the workspace endpoints to `Bun.serve`'s fetch handler**

Inside `async fetch(req)` (line ~162), right before `if (url.pathname === "/status")`, insert:

```js
    if (url.pathname === "/workspace/init" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      if (!id) return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      const dir = projectDirOf(id);
      mkdirSync(dir, { recursive: true });
      const init = Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir });
      if (init.exitCode !== 0) {
        const detail = init.stderr ? init.stderr.toString().slice(0, 500) : "git unavailable";
        return Response.json({ ok: false, error: "git_init_failed", detail }, { status: 500 });
      }
      return Response.json({ ok: true, dir: `projects/${id}` });
    }

    if (url.pathname === "/workspace/write" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      const files = Array.isArray(body.files) ? body.files : [];
      if (!id || !files.length) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      const dir = projectDirOf(id);
      if (!existsSync(dir)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      let written = 0;
      for (const f of files.slice(0, 200)) {
        const rel = resolveProjectRelPath(f && f.path);
        if (!rel || typeof f.content !== "string" || f.content.length > 2_000_000) continue;
        const abs = `${dir}/${rel}`;
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
        written++;
      }
      return Response.json({ ok: true, written });
    }

    if (url.pathname === "/workspace/file" && req.method === "GET") {
      const id = sanitizeProjectId(url.searchParams.get("project"));
      const rel = resolveProjectRelPath(url.searchParams.get("path"));
      if (!id || !rel) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      const abs = `${projectDirOf(id)}/${rel}`;
      if (!existsSync(abs)) return Response.json({ ok: false, error: "file_not_found" }, { status: 404 });
      const content = readFileSync(abs, "utf8").slice(0, 200_000);
      return Response.json({ ok: true, path: rel, content });
    }

    if (url.pathname === "/workspace/exec" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = sanitizeProjectId(body.project);
      const cmd = body.cmd;
      if (!id || !isAllowedCommand(cmd)) {
        return Response.json({ ok: false, error: "invalid_command" }, { status: 400 });
      }
      const dir = projectDirOf(id);
      if (!existsSync(dir)) return Response.json({ ok: false, error: "project_not_found" }, { status: 404 });
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 30_000, 1_000), 120_000);
      const started = Date.now();
      const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      const stdout = (await new Response(proc.stdout).text()).slice(0, 30_000);
      const stderr = (await new Response(proc.stderr).text()).slice(0, 30_000);
      return Response.json({ ok: exitCode === 0, exitCode, stdout, stderr, durationMs: Date.now() - started });
    }
```

- [ ] **Step 4: Accept `{ project }` in `/run` (backward compatible)**

Replace the existing `/run` handler (line ~168-174):

```js
    if (url.pathname === "/run" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body && body.project ? sanitizeProjectId(body.project) : null;
      if (body && body.project && !id) {
        return Response.json({ ok: false, error: "invalid_project" }, { status: 400 });
      }
      startDev(id).catch((e) => {
        state.error = String(e && e.message ? e.message : e);
        state.running = false;
      });
      return Response.json({ ok: true, port: DEV_PORT, project: id });
    }
```

- [ ] **Step 5: Update the runner mounts in `docker-compose.yml`**

In the `runner` service, replace:

```yaml
    command: ["bun", "/code-runner.js"]
```
with:
```yaml
    command: ["bun", "/scripts/code-runner.js"]
```
and replace the volume line `- ./scripts/code-runner.js:/code-runner.js:ro` with:
```yaml
      - ./scripts/code-runner.js:/scripts/code-runner.js:ro
      - ./scripts/code-runner-utils.js:/scripts/code-runner-utils.js:ro
```
(The `require("./code-runner-utils.js")` resolves relative to the entry file, so both files must live side-by-side in `/scripts/`.)

- [ ] **Step 6: Manual verification (only if Docker is available locally)**

```bash
docker compose --profile opencode up -d runner
curl -s -X POST http://localhost:4097/workspace/init -H "Content-Type: application/json" -d "{\"project\":\"smoke1\"}"
```
Expected: `{"ok":true,"dir":"projects/smoke1"}`. Note: port 4097 is `expose`-only (internal); to curl from the host either add a temporary `ports: "4097:4097"` mapping or exec from the backend container (`docker compose exec backend curl ...`). Undo any temporary mapping. If Docker/profile is not available, skip — runner contracts are pinned by the backend client tests in Task 5.

- [ ] **Step 7: Commit**

```bash
git add scripts/code-runner.js docker-compose.yml
git commit -m "feat(codex): workspace API en el runner — dirs por proyecto, git, exec con allowlist

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Git en la imagen del runner (condicional)

**Files:**
- Create: `scripts/runner.Dockerfile` (solo si hace falta)
- Modify: `docker-compose.yml` (solo si hace falta)

- [ ] **Step 1: Check whether `oven/bun:1` already ships git**

```bash
docker run --rm oven/bun:1 git --version
```
- Exit 0 (prints `git version ...`): **skip Steps 2-3**, this task is done — commit nothing.
- Non-zero / "executable file not found": continue.

(If Docker isn't available locally, assume git is missing and do Steps 2-3 anyway — the Dockerfile is harmless if git was already present.)

- [ ] **Step 2: Create `scripts/runner.Dockerfile`**

```dockerfile
FROM oven/bun:1
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Switch the `runner` service to build the image**

In `docker-compose.yml`, in the `runner` service replace:

```yaml
    image: oven/bun:1
```
with:
```yaml
    build:
      context: ./scripts
      dockerfile: runner.Dockerfile
```

- [ ] **Step 4: Verify and commit (only if Steps 2-3 ran)**

```bash
docker compose --profile opencode build runner && docker compose --profile opencode run --rm runner git --version
```
Expected: `git version 2.x`.

```bash
git add scripts/runner.Dockerfile docker-compose.yml
git commit -m "build(codex): git en la imagen del runner para checkpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cliente HTTP del runner en el backend

**Files:**
- Create: `backend/src/services/codex/runner-client.js`
- Test: `backend/tests/codex-runner-client.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunnerClient, RunnerError, runnerDevUrl } = require('../src/services/codex/runner-client');

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return handler(calls[calls.length - 1]);
  };
  return { impl, calls };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('initWorkspace POSTs { project } to /workspace/init', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, dir: 'projects/p1' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  const out = await client.initWorkspace('p1');
  assert.equal(out.dir, 'projects/p1');
  assert.equal(calls[0].url, 'http://runner:4097/workspace/init');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { project: 'p1' });
});

test('exec POSTs { project, cmd, timeoutMs } and returns the runner payload verbatim', async () => {
  const payload = { ok: false, exitCode: 1, stdout: '', stderr: 'boom', durationMs: 12 };
  const { impl, calls } = fakeFetch(() => jsonResponse(payload));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  const out = await client.exec('p1', ['git', 'status'], { timeoutMs: 5000 });
  assert.deepEqual(out, payload); // exit≠0 viaja como dato, no como excepción
  assert.deepEqual(calls[0].body, { project: 'p1', cmd: ['git', 'status'], timeoutMs: 5000 });
});

test('readFile URL-encodes project and path', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, path: 'a b.txt', content: 'x' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await client.readFile('p1', 'src/a b.txt');
  assert.equal(calls[0].url, 'http://runner:4097/workspace/file?project=p1&path=src%2Fa%20b.txt');
});

test('non-2xx responses throw RunnerError with status and body', async () => {
  const { impl } = fakeFetch(() => jsonResponse({ error: 'invalid_project' }, 400));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await assert.rejects(() => client.initWorkspace('!!'), (err) => {
    assert.ok(err instanceof RunnerError);
    assert.equal(err.status, 400);
    assert.deepEqual(err.body, { error: 'invalid_project' });
    return true;
  });
});

test('network failures throw RunnerError with status 0', async () => {
  const impl = async () => { throw new Error('ECONNREFUSED'); };
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await assert.rejects(() => client.devStatus(), (err) => {
    assert.ok(err instanceof RunnerError);
    assert.equal(err.status, 0);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

test('startDev posts { project } to /run; runnerDevUrl honours env override', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, port: 5173, project: 'p1' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await client.startDev('p1');
  assert.equal(calls[0].url, 'http://runner:4097/run');
  assert.deepEqual(calls[0].body, { project: 'p1' });
  assert.equal(runnerDevUrl({ CODE_RUNNER_DEV_URL: 'https://preview.example' }), 'https://preview.example');
  assert.equal(runnerDevUrl({}), 'http://localhost:5173');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-runner-client.test.js`
Expected: FAIL — `Cannot find module '../src/services/codex/runner-client'`

- [ ] **Step 3: Write the implementation**

`backend/src/services/codex/runner-client.js`:

```js
'use strict';

/**
 * codex/runner-client — typed HTTP client for the code-runner sidecar
 * (scripts/code-runner.js control API). The runner is the only process with
 * filesystem access to the sandbox volume, so every workspace/git/exec
 * operation goes through it. Injectable fetch for offline tests.
 */

class RunnerError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.status = status;
    this.body = body;
  }
}

function runnerBaseUrl(env = process.env) {
  return String(env.CODE_RUNNER_URL || 'http://runner:4097').replace(/\/+$/, '');
}

function runnerDevUrl(env = process.env) {
  return env.CODE_RUNNER_DEV_URL || 'http://localhost:5173';
}

function createRunnerClient({ fetchImpl = fetch, baseUrl = runnerBaseUrl(), timeoutMs = 30_000 } = {}) {
  async function call(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new RunnerError(`runner unreachable: ${err.message}`, { status: 0 });
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new RunnerError(json.error || `runner http ${res.status}`, { status: res.status, body: json });
    }
    return json;
  }

  return {
    initWorkspace: (project) => call('POST', '/workspace/init', { project }),
    writeFiles: (project, files) => call('POST', '/workspace/write', { project, files }),
    readFile: (project, path) =>
      call('GET', `/workspace/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`),
    exec: (project, cmd, opts = {}) => call('POST', '/workspace/exec', { project, cmd, timeoutMs: opts.timeoutMs }),
    startDev: (project) => call('POST', '/run', { project }),
    devStatus: () => call('GET', '/status'),
    stopDev: () => call('POST', '/stop'),
  };
}

module.exports = { createRunnerClient, RunnerError, runnerBaseUrl, runnerDevUrl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-runner-client.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Register the test and commit**

Append ` tests/codex-runner-client.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add backend/src/services/codex/runner-client.js backend/tests/codex-runner-client.test.js backend/package.json
git commit -m "feat(codex): cliente HTTP del runner — workspace, exec y dev server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Starter determinista (`starter-files.js`)

**Files:**
- Create: `backend/src/services/codex/starter-files.js`
- Test: `backend/tests/codex-starter-files.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { starterFiles, escapeHtml } = require('../src/services/codex/starter-files');

test('same input produces byte-identical output (deterministic)', () => {
  const a = starterFiles({ projectName: 'Mi tienda' });
  const b = starterFiles({ projectName: 'Mi tienda' });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('emits a runnable Vite project: package.json + index.html + src/main.js + .gitignore', () => {
  const files = starterFiles({ projectName: 'Demo' });
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths, ['package.json', 'index.html', 'src/main.js', '.gitignore']);
  const pkg = JSON.parse(files[0].content);
  assert.equal(pkg.scripts.dev, 'vite');
  assert.ok(pkg.devDependencies.vite);
  assert.match(files[1].content, /src\/main\.js/);
  assert.match(files[3].content, /node_modules/);
});

test('project name is HTML-escaped (anti-injection)', () => {
  const files = starterFiles({ projectName: '<script>alert(1)</script>' });
  const html = files.find((f) => f.path === 'index.html').content;
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(escapeHtml(`a&<>"'b`), 'a&amp;&lt;&gt;&quot;&#39;b');
});

test('empty or missing name falls back to a default', () => {
  const html = starterFiles({}).find((f) => f.path === 'index.html').content;
  assert.match(html, /Proyecto Codex/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-starter-files.test.js`
Expected: FAIL — `Cannot find module '../src/services/codex/starter-files'`

- [ ] **Step 3: Write the implementation**

`backend/src/services/codex/starter-files.js`:

```js
'use strict';

/**
 * codex/starter-files — deterministic minimal Vite starter for a freshly
 * provisioned Codex workspace. Pure: same input → identical bytes. User text
 * is HTML-escaped (same anti-injection convention as lib/code-agent/escape.ts).
 */

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function starterFiles({ projectName } = {}) {
  const rawName = String(projectName || '').trim().slice(0, 80);
  const name = escapeHtml(rawName) || 'Proyecto Codex';

  const pkg = {
    name: 'codex-workspace',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    devDependencies: { vite: '^7.0.0' },
  };

  const indexHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name} · Codex</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0b0b10; color: #e8e8f0; }
      main { text-align: center; padding: 2rem; }
      h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
      p { color: #99a; margin: 0; }
      .dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #7c5cff; margin-right: 0.5rem; }
    </style>
  </head>
  <body>
    <main>
      <h1><span class="dot"></span>${name}</h1>
      <p>Workspace listo. Describe en el chat qué quieres construir.</p>
    </main>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'index.html', content: indexHtml },
    { path: 'src/main.js', content: 'console.log("codex workspace ready");\n' },
    { path: '.gitignore', content: 'node_modules\ndist\n' },
  ];
}

module.exports = { starterFiles, escapeHtml };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-starter-files.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Register the test and commit**

Append ` tests/codex-starter-files.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add backend/src/services/codex/starter-files.js backend/tests/codex-starter-files.test.js backend/package.json
git commit -m "feat(codex): starter Vite determinista con escape anti-inyección

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Servicio de provisioning (`workspace.js`)

**Files:**
- Create: `backend/src/services/codex/workspace.js`
- Test: `backend/tests/codex-workspace.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { provisionWorkspace, gitCommitAll } = require('../src/services/codex/workspace');

function fakeRunner({ execResults = {} } = {}) {
  const calls = [];
  return {
    calls,
    initWorkspace: async (project) => { calls.push(['initWorkspace', project]); return { ok: true }; },
    writeFiles: async (project, files) => { calls.push(['writeFiles', project, files]); return { ok: true, written: files.length }; },
    exec: async (project, cmd) => {
      calls.push(['exec', project, cmd]);
      const key = cmd.join(' ');
      for (const [pattern, result] of Object.entries(execResults)) {
        if (key.includes(pattern)) return result;
      }
      if (key.includes('rev-parse')) return { ok: true, exitCode: 0, stdout: 'abc123\n', stderr: '' };
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

test('provisionWorkspace runs init → write starter → git add/commit → rev-parse', async () => {
  const runner = fakeRunner();
  const out = await provisionWorkspace({ project: 'p1', projectName: 'Demo', runner });
  assert.equal(out.workspacePath, 'projects/p1');
  assert.equal(out.commitSha, 'abc123');
  const kinds = runner.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['initWorkspace', 'writeFiles', 'exec', 'exec', 'exec']);
  const writtenPaths = runner.calls[1][2].map((f) => f.path);
  assert.ok(writtenPaths.includes('package.json'));
  const execCmds = runner.calls.filter((c) => c[0] === 'exec').map((c) => c[2].join(' '));
  assert.match(execCmds[0], /^git add -A$/);
  assert.match(execCmds[1], /git .*commit .*workspace inicial/);
  assert.match(execCmds[2], /git rev-parse HEAD/);
});

test('git commit failures throw with the failing label and stderr detail', async () => {
  const runner = fakeRunner({
    execResults: { 'commit': { ok: false, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } },
  });
  await assert.rejects(
    () => provisionWorkspace({ project: 'p1', projectName: 'Demo', runner }),
    /git commit failed \(exit 128\).*not a git repository/,
  );
});

test('gitCommitAll returns the trimmed HEAD sha', async () => {
  const runner = fakeRunner();
  const sha = await gitCommitAll(runner, 'p9', 'feat: checkpoint');
  assert.equal(sha, 'abc123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-workspace.test.js`
Expected: FAIL — `Cannot find module '../src/services/codex/workspace'`

- [ ] **Step 3: Write the implementation**

`backend/src/services/codex/workspace.js`:

```js
'use strict';

/**
 * codex/workspace — provisioning orchestration over the runner client:
 * init dir + git repo → write starter files → initial commit. Pure
 * orchestration (runner injected) so tests stay offline. The commit helper
 * is reused by F3 checkpoints.
 */

const { starterFiles } = require('./starter-files');

const GIT_IDENT = ['-c', 'user.name=Codex Agent', '-c', 'user.email=codex@siragpt.local'];

async function execOrThrow(runner, project, cmd, label) {
  const out = await runner.exec(project, cmd);
  if (out.exitCode !== 0) {
    const detail = String(out.stderr || out.stdout || '').slice(0, 400);
    throw new Error(`${label} failed (exit ${out.exitCode}): ${detail}`);
  }
  return out;
}

async function gitCommitAll(runner, project, message) {
  await execOrThrow(runner, project, ['git', 'add', '-A'], 'git add');
  await execOrThrow(
    runner,
    project,
    ['git', ...GIT_IDENT, 'commit', '--allow-empty', '-m', message],
    'git commit',
  );
  const head = await execOrThrow(runner, project, ['git', 'rev-parse', 'HEAD'], 'git rev-parse');
  return String(head.stdout || '').trim();
}

async function provisionWorkspace({ project, projectName, runner }) {
  await runner.initWorkspace(project);
  await runner.writeFiles(project, starterFiles({ projectName }));
  const commitSha = await gitCommitAll(runner, project, 'chore(codex): workspace inicial');
  return { workspacePath: `projects/${project}`, commitSha };
}

module.exports = { provisionWorkspace, gitCommitAll };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-workspace.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the test and commit**

Append ` tests/codex-workspace.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add backend/src/services/codex/workspace.js backend/tests/codex-workspace.test.js backend/package.json
git commit -m "feat(codex): provisioning del workspace — starter + git init + commit inicial

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Servicio de proyectos (`project-service.js`)

**Files:**
- Create: `backend/src/services/codex/project-service.js`
- Test: `backend/tests/codex-project-service.test.js`
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProject, listProjects, getProject } = require('../src/services/codex/project-service');

function fakeDb() {
  const rows = new Map();
  let n = 0;
  return {
    rows,
    codexProject: {
      create: async ({ data }) => {
        const row = { id: `p${++n}`, error: null, workspacePath: null, previewUrl: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = { ...rows.get(where.id), ...data, updatedAt: new Date() };
        rows.set(where.id, row);
        return { ...row };
      },
      findMany: async ({ where }) => [...rows.values()].filter((r) => r.userId === where.userId),
      findFirst: async ({ where }) => {
        const row = rows.get(where.id);
        return row && row.userId === where.userId ? { ...row } : null;
      },
    },
  };
}

function okRunner() {
  return {
    initWorkspace: async () => ({ ok: true }),
    writeFiles: async () => ({ ok: true, written: 4 }),
    exec: async (project, cmd) =>
      cmd.includes('rev-parse')
        ? { ok: true, exitCode: 0, stdout: 'sha1\n', stderr: '' }
        : { ok: true, exitCode: 0, stdout: '', stderr: '' },
  };
}

test('createProject provisions and returns a ready public projection', async () => {
  const db = fakeDb();
  const project = await createProject({ userId: 'u1', name: 'Tienda', runner: okRunner(), db, env: {} });
  assert.equal(project.status, 'ready');
  assert.equal(project.workspacePath, 'projects/p1');
  assert.equal(project.previewUrl, 'http://localhost:5173');
  assert.equal(project.userId, undefined); // proyección pública: sin userId
});

test('provisioning failure persists status=error without throwing', async () => {
  const db = fakeDb();
  const badRunner = { initWorkspace: async () => { throw new Error('runner unreachable: ECONNREFUSED'); } };
  const project = await createProject({ userId: 'u1', name: 'X', runner: badRunner, db, env: {} });
  assert.equal(project.status, 'error');
  assert.match(project.error, /ECONNREFUSED/);
  assert.equal(db.rows.get(project.id).status, 'error');
});

test('getProject is scoped by userId; listProjects returns only own projects', async () => {
  const db = fakeDb();
  const mine = await createProject({ userId: 'u1', name: 'A', runner: okRunner(), db, env: {} });
  await createProject({ userId: 'u2', name: 'B', runner: okRunner(), db, env: {} });
  assert.equal(await getProject({ userId: 'u2', id: mine.id, db }), null);
  const list = await listProjects({ userId: 'u1', db });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'A');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-project-service.test.js`
Expected: FAIL — `Cannot find module '../src/services/codex/project-service'`

- [ ] **Step 3: Write the implementation**

`backend/src/services/codex/project-service.js`:

```js
'use strict';

/**
 * codex/project-service — CodexProject CRUD + provisioning. The DB client and
 * runner are injectable (defaults: shared Prisma + real runner client) so the
 * route stays thin and the tests stay offline.
 */

const defaultPrisma = (() => {
  try { return require('../../config/database'); } catch { return null; }
})();
const { createRunnerClient, runnerDevUrl } = require('./runner-client');
const { provisionWorkspace } = require('./workspace');

function publicProject(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    workspacePath: row.workspacePath,
    previewUrl: row.previewUrl,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requireDb(db) {
  if (!db || !db.codexProject) throw new Error('database unavailable');
  return db;
}

async function createProject({ userId, name, brief = null, runner, db = defaultPrisma, env = process.env }) {
  const prisma = requireDb(db);
  const runnerClient = runner || createRunnerClient();
  const row = await prisma.codexProject.create({
    data: { userId, name, brief, status: 'provisioning' },
  });
  try {
    const { workspacePath } = await provisionWorkspace({ project: row.id, projectName: name, runner: runnerClient });
    const ready = await prisma.codexProject.update({
      where: { id: row.id },
      data: { status: 'ready', workspacePath, previewUrl: runnerDevUrl(env) },
    });
    return publicProject(ready);
  } catch (err) {
    const failed = await prisma.codexProject.update({
      where: { id: row.id },
      data: { status: 'error', error: String((err && err.message) || err).slice(0, 2000) },
    });
    return publicProject(failed);
  }
}

async function listProjects({ userId, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const rows = await prisma.codexProject.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  return rows.map(publicProject);
}

async function getProject({ userId, id, db = defaultPrisma }) {
  const prisma = requireDb(db);
  const row = await prisma.codexProject.findFirst({ where: { id, userId } });
  return row ? publicProject(row) : null;
}

module.exports = { createProject, listProjects, getProject, publicProject };
```

Nota: el `fakeDb` del test no implementa `orderBy/take` — `findMany` ignora esos args, suficiente para el contrato probado.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-project-service.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the test and commit**

Append ` tests/codex-project-service.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add backend/src/services/codex/project-service.js backend/tests/codex-project-service.test.js backend/package.json
git commit -m "feat(codex): project-service — crear/listar/obtener con provisioning y error persistido

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Rutas `/api/codex` + montaje

**Files:**
- Create: `backend/src/routes/codex.js`
- Test: `backend/tests/codex-route-contract.test.js`
- Modify: `backend/index.js` (require + mount)
- Modify: `backend/package.json` (script `test`)

- [ ] **Step 1: Write the failing contract test**

Patrón calcado de `backend/tests/builder-route.test.js`: stub de auth y de los servicios vía `mockResolvedModule` ANTES de requerir el router.

```js
'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { mockResolvedModule } = require('./http-test-utils');

// Stub auth BEFORE the codex router loads it.
const authPath = require.resolve('../src/middleware/auth');
const restoreAuth = mockResolvedModule(authPath, {
  authenticateToken(req, _res, next) {
    req.user = { id: 'u-1' };
    next();
  },
});

// Stub project-service + runner-client BEFORE the router loads them.
const serviceCalls = [];
const servicePath = require.resolve('../src/services/codex/project-service');
const restoreService = mockResolvedModule(servicePath, {
  createProject: async (args) => {
    serviceCalls.push(['createProject', args]);
    return { id: 'p1', name: args.name, status: 'ready', workspacePath: 'projects/p1', previewUrl: 'http://localhost:5173', error: null };
  },
  listProjects: async (args) => {
    serviceCalls.push(['listProjects', args]);
    return [{ id: 'p1', name: 'A', status: 'ready' }];
  },
  getProject: async (args) => {
    serviceCalls.push(['getProject', args]);
    return args.id === 'p1' ? { id: 'p1', name: 'A', status: 'ready' } : null;
  },
});

const runnerCalls = [];
const runnerPath = require.resolve('../src/services/codex/runner-client');
const restoreRunner = mockResolvedModule(runnerPath, {
  createRunnerClient: () => ({
    startDev: async (project) => { runnerCalls.push(['startDev', project]); return { ok: true, port: 5173, project }; },
    devStatus: async () => ({ running: true, ready: true, project: 'p1' }),
    stopDev: async () => ({ ok: true }),
  }),
  runnerDevUrl: () => 'http://localhost:5173',
  RunnerError: class RunnerError extends Error {},
});

const codexRoutes = require('../src/routes/codex');

after(() => { restoreAuth(); restoreService(); restoreRunner(); delete process.env.CODEX_AGENT_V2; });
beforeEach(() => { process.env.CODEX_AGENT_V2 = '1'; });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/codex', codexRoutes);
  return app;
}

test('GET /health responds 200 with enabled=false when the flag is off', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).get('/api/codex/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, enabled: false });
});

test('flag off ⇒ every other route is 404 not_found', async () => {
  delete process.env.CODEX_AGENT_V2;
  const res = await request(buildApp()).post('/api/codex/projects').send({ name: 'X' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('POST /projects validates name and forwards userId to the service', async () => {
  const bad = await request(buildApp()).post('/api/codex/projects').send({});
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_failed');

  const res = await request(buildApp()).post('/api/codex/projects').send({ name: '  Tienda  ' });
  assert.equal(res.status, 201);
  assert.equal(res.body.project.id, 'p1');
  const call = serviceCalls.find((c) => c[0] === 'createProject');
  assert.equal(call[1].userId, 'u-1');
  assert.equal(call[1].name, 'Tienda');
});

test('GET /projects lists own projects; GET /projects/:id 404s for foreign ids', async () => {
  const list = await request(buildApp()).get('/api/codex/projects');
  assert.equal(list.status, 200);
  assert.equal(list.body.projects.length, 1);

  const found = await request(buildApp()).get('/api/codex/projects/p1');
  assert.equal(found.status, 200);
  const missing = await request(buildApp()).get('/api/codex/projects/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'project_not_found');
});

test('POST /projects/:id/preview/start proxies the runner and adds devUrl', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/p1/preview/start');
  assert.equal(res.status, 200);
  assert.equal(res.body.devUrl, 'http://localhost:5173');
  assert.deepEqual(runnerCalls.at(-1), ['startDev', 'p1']);
});

test('preview routes 404 on foreign project ids (ownership gate)', async () => {
  const res = await request(buildApp()).post('/api/codex/projects/nope/preview/start');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/codex-route-contract.test.js`
Expected: FAIL — `Cannot find module '../src/routes/codex'`

- [ ] **Step 3: Write the route**

`backend/src/routes/codex.js`:

```js
'use strict';

/**
 * codex route — Codex Agent V2 (spec docs/codex-agent-ux.md, flag CODEX_AGENT_V2).
 *
 *   GET  /api/codex/health                       → { ok, enabled }   (público, SIEMPRE 200)
 *   — resto: flag off ⇒ 404 not_found —
 *   POST /api/codex/projects                     → crea + provisiona  (auth)
 *   GET  /api/codex/projects                     → lista del usuario  (auth)
 *   GET  /api/codex/projects/:id                 → detalle            (auth)
 *   POST /api/codex/projects/:id/preview/start   → dev server on      (auth)
 *   GET  /api/codex/projects/:id/preview/status  → estado del runner  (auth)
 *   POST /api/codex/projects/:id/preview/stop    → dev server off     (auth)
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { isCodexV2Enabled } = require('../services/codex/flags');
const projectService = require('../services/codex/project-service');
const { createRunnerClient, runnerDevUrl } = require('../services/codex/runner-client');

const router = express.Router();

// Público y SIEMPRE 200: el frontend decide si renderiza la UI V2 con esto.
router.get('/health', (_req, res) => res.json({ ok: true, enabled: isCodexV2Enabled() }));

router.use((req, res, next) => {
  if (!isCodexV2Enabled()) return res.status(404).json({ error: 'not_found' });
  next();
});

router.post(
  '/projects',
  authenticateToken,
  [body('name').isString().withMessage('name must be a string').bail().trim().isLength({ min: 1, max: 80 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_failed', details: errors.array() });
    try {
      const project = await projectService.createProject({
        userId: req.user.id,
        name: req.body.name.trim(),
        brief: req.body.brief ?? null,
      });
      return res.status(201).json({ project });
    } catch (err) {
      return res.status(500).json({ error: 'codex_create_failed', message: err.message });
    }
  },
);

router.get('/projects', authenticateToken, async (req, res) => {
  try {
    return res.json({ projects: await projectService.listProjects({ userId: req.user.id }) });
  } catch (err) {
    return res.status(500).json({ error: 'codex_list_failed', message: err.message });
  }
});

router.get('/projects/:id', authenticateToken, async (req, res) => {
  try {
    const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
    if (!project) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ project });
  } catch (err) {
    return res.status(500).json({ error: 'codex_get_failed', message: err.message });
  }
});

// Ownership gate compartido por las rutas de preview.
async function loadOwnedProject(req, res) {
  const project = await projectService.getProject({ userId: req.user.id, id: req.params.id });
  if (!project) {
    res.status(404).json({ error: 'project_not_found' });
    return null;
  }
  return project;
}

router.post('/projects/:id/preview/start', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().startDev(project.id);
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.get('/projects/:id/preview/status', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    const out = await createRunnerClient().devStatus();
    return res.json({ ...out, devUrl: runnerDevUrl() });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

router.post('/projects/:id/preview/stop', authenticateToken, async (req, res) => {
  try {
    const project = await loadOwnedProject(req, res);
    if (!project) return undefined;
    await createRunnerClient().stopDev();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'runner_unreachable', message: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/codex-route-contract.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Mount the route in `backend/index.js`**

Find the require block (`grep -n "builderRoutes = require" backend/index.js`) and add next to it:

```js
const codexRoutes = require('./src/routes/codex');
```

Then, next to `app.use('/api/builder', builderRoutes);` (line ~1004), add:

```js
app.use('/api/codex', codexRoutes);
```

(The route self-gates on the flag, so the mount is unconditional — same pattern as opencode's `requireConfigured`.)

- [ ] **Step 6: Boot smoke check**

Run (cwd `backend/`): `node -e "require('./src/routes/codex'); console.log('codex route loads ok')"`
Expected: `codex route loads ok` (no DB/Redis needed — the Prisma require is try/catch-guarded).

- [ ] **Step 7: Register the test and commit**

Append ` tests/codex-route-contract.test.js` to the `"test"` script in `backend/package.json`.

```bash
git add backend/src/routes/codex.js backend/tests/codex-route-contract.test.js backend/index.js backend/package.json
git commit -m "feat(codex): rutas /api/codex — health, proyectos y preview gated por flag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Gates finales + push

**Files:** ninguno nuevo — verificación global.

- [ ] **Step 1: Full backend test suite**

Run (cwd repo root): `npm test`
Expected: todas verdes (~2900 + las 25 nuevas). Si algo falla, arreglar antes de seguir — no se pushea en rojo.

- [ ] **Step 2: Lint + typecheck**

```bash
npm run lint
npx tsc --noEmit --skipLibCheck
```
Expected: lint dentro del ratchet (max-warnings 50); tsc sin errores (F1 no toca frontend, debe salir limpio igual que en main).

- [ ] **Step 3: Rebase + push**

```bash
git pull --rebase origin main
git push origin main
```

- [ ] **Step 4: Watch CI**

```bash
gh run watch --repo SiraGPT-ORg/siraGPT
```
Expected: workflow `ci.yml` en verde (frontend + backend + security + docker). Si falla, diagnosticar con `gh run view --log-failed`, corregir, commit y push de nuevo.

---

## Self-review (hecho al escribir el plan)

- **Cobertura F1 vs spec §12:** migración ✔ (Task 2), flag ✔ (Task 1), rutas esqueleto ✔ (Task 10), provisioning workspace+git+preview ✔ (Tasks 4-9). El arranque del dev server es on-demand (`preview/start`) y no parte del provisioning síncrono — decisión registrada en el spec (runner single-tenant).
- **Consistencia de tipos:** `runner.exec()` devuelve `{ ok, exitCode, stdout, stderr, durationMs }` (Task 4 runner ↔ Task 6 cliente ↔ Task 8 workspace ↔ fakes de Tasks 8-9). `provisionWorkspace({ project, projectName, runner })` y su retorno `{ workspacePath, commitSha }` coinciden entre Tasks 8 y 9. `starterFiles({ projectName })` coincide entre Tasks 7 y 8.
- **Exit≠0 vs excepción:** el runner responde HTTP 200 con `ok:false/exitCode≠0` (fallo del comando = dato); el cliente solo lanza `RunnerError` en HTTP no-2xx o red. `workspace.js` convierte exitCode≠0 en excepción con etiqueta. Probado en los tres niveles.
