# Coding-sandbox session adapter (AGENTES_CODING_V2 Phase 2a)

Internal adapter for isolated **coding sessions** behind
`AGENTES_CODING_V2` (default **OFF**). Canonical UI stays `/agentes`.
This is not a `/code` revival, not F7 / SiraComputer, and not a
Kubernetes OpenSandbox cluster.

Architecture contract (Phase 1):
[`docs/agentes-arquitectura.md`](./agentes-arquitectura.md) (PR #635 if
that file is not on the branch yet). License / Tier S catalog:
[`docs/oss-catalog.md`](./oss-catalog.md). Product planes:
[`AGENTS.md`](../AGENTS.md).

## What this PR adds

| Piece | Path |
|---|---|
| Flag | `AGENTES_CODING_V2` → `isAgentesCodingV2Enabled()` |
| Module | `backend/src/services/agentes-coding/coding-sandbox/` |
| HTTP | `GET /api/agentes-coding/health` always 200 `{ ok, enabled }` |
| Sessions | `/api/agentes-coding/sessions*` — **404** unless the flag is on |
| Repo-map | `GET|POST /sessions/:id/map` — Phase 3b, see [`docs/agentes-coding-repomap.md`](./agentes-coding-repomap.md) |
| Terminal | `POST /sessions/:id/terminal*` — Phase 3d PTY stub, see [`docs/agentes-coding-terminal.md`](./agentes-coding-terminal.md) |
| Preview | `POST /sessions/:id/preview` — Phase 3e signed exposePort, see [`docs/agentes-coding-preview.md`](./agentes-coding-preview.md) |
| Git | `/sessions/:id/git/*` — Phase 3f checkpoints, see [`docs/agentes-coding-git.md`](./agentes-coding-git.md) |
| Export / deploy | `/sessions/:id/export` · `/sessions/:id/deploy` — Phase 3g, see [`docs/agentes-coding-export-deploy.md`](./agentes-coding-export-deploy.md) |
| Harness | `/sessions/:id/harness*` — Phase 4a tool loop, see [`docs/agentes-coding-harness.md`](./agentes-coding-harness.md) |
| DEV compose | `docker-compose.coding-sandbox.yml` profile `agentes-coding` |

Interface (same on memory + docker drivers):

`createSession` · `exec` · `readFile` · `writeFile` · `listFiles` ·
`exposePort` (deny-by-default; signed URL + localhost metadata) ·
`listPorts` · `unexposePort` · `resolvePreview` · `destroy`

## Drivers

| Driver | When | Isolation |
|---|---|---|
| `memory` | default, CI, no Docker | in-process Map, path jail |
| `docker` | `AGENTES_CODING_SANDBOX_DRIVER=docker` | `docker run` per session |

Docker DEV argv (Lenovo / F1-style, injectable in tests):

- `--network none` unless an allowlist attaches `siragpt-coding-sandbox`
  (compose network is `internal: true`)
- `--memory` / `--cpus` / `--pids-limit` stubs
- `--security-opt no-new-privileges`, `--cap-drop ALL`, `--read-only`
- tmpfs `/workspace`, user `10001:10001`
- **no** Docker socket, **no** prod `.env`, **no** control Postgres/Redis

```bash
# DEV only — does not start on default compose up
docker compose -f docker-compose.yml -f docker-compose.coding-sandbox.yml \
  --profile agentes-coding build
```

The overlay does **not** run a shared long-lived executor. The Node
adapter `docker run`s one ephemeral container per session from
`siragpt-coding-sandbox:dev` (see `infra/coding-sandbox/Dockerfile`).

## Errors (Spanish)

Stable codes: `E_FLAG_OFF` `E_PARAMS` `E_SESSION_NOT_FOUND`
`E_SESSION_EXPIRED` `E_PATH_ESCAPE` `E_NETWORK_DENIED` `E_PORT_DENIED`
`E_PREVIEW_EXPIRED` `E_PREVIEW_FAILED`
`E_TIMEOUT` `E_QUOTA` `E_PROVIDER` `E_CANCELLED` (AGENTS.md §16).

## Out of scope

Cloning user repos, enabling the flag on the Lenovo origin, Daytona
(AGPL), full OpenSandbox/K8s deploy. Phase 3a IDE shell (flag-gated
Monaco on `/agentes`): [`docs/agentes-coding-ide.md`](./agentes-coding-ide.md).
Phase 3c structural edit (ast-grep patterns, flag-gated):
[`docs/agentes-coding-struct-edit.md`](./agentes-coding-struct-edit.md).
Phase 3d terminal channel (API-only PTY stub):
[`docs/agentes-coding-terminal.md`](./agentes-coding-terminal.md).
Phase 3e preview `exposePort` (signed URL stub):
[`docs/agentes-coding-preview.md`](./agentes-coding-preview.md).
Phase 3f session git checkpoints (API-only):
[`docs/agentes-coding-git.md`](./agentes-coding-git.md).
Phase 3g export + deploy stubs (zip/tar.gz + Coolify/Dokploy API-only):
[`docs/agentes-coding-export-deploy.md`](./agentes-coding-export-deploy.md).
Phase 4a session harness (API-only plan/tool/result loop):
[`docs/agentes-coding-harness.md`](./agentes-coding-harness.md).

## Tests

```bash
cd backend && node --test tests/agentes-coding-flags.test.js tests/agentes-coding-sandbox.test.js tests/agentes-coding-repo-map.test.js tests/agentes-coding-structural-edit.test.js tests/agentes-coding-terminal.test.js tests/agentes-coding-preview.test.js tests/agentes-coding-git.test.js tests/agentes-coding-export-deploy.test.js tests/agentes-coding-harness.test.js tests/agentes-coding-harness-permissions.test.js
```
