# Lenovo iliagpt — computer orchestrator (live publish)

Production publish does **not** use repo `deploy/Caddyfile`.

| Live path (Lenovo) | Role |
|---|---|
| `/home/user/deployments/iliagpt/Caddyfile` | Gateway config (`iliagpt-gateway`). `:80` file with `@sse` for `/api/ai/generate*` `/api/ai/stream*` `/api/*/pending-stream*`. `encode` never wraps SSE. |
| `/home/user/deployments/iliagpt/compose.yaml` | Compose project **`iliagpt`** (`iliagpt-backend`, `iliagpt-runner`, `iliagpt-frontend`, `iliagpt-gateway`). |
| `publish.sh` (installed on Lenovo; reviewed source in this folder) | Publishes **runner backend frontend** with its existing gates and rollback. |
| `publish-computer-orchestrator.sh` (versioned in this repo) | Independently verifies and updates the **existing** orchestrator after successful app publication. |

**Do not** copy `deploy/Caddyfile` over the live file. That drops the stronger `@sse` block and brings back the Pensando hang.

The app publisher does not update the orchestrator. The production workflow invokes the versioned companion below; it refuses to create a missing service. Initial infrastructure provisioning remains separate.

## 1. Caddy — only live edit

Leave `@sse` and `encode` untouched. Next to that block, add the handle from `sessions.handle.caddy`:

```
handle /sessions/* {
	reverse_proxy siragpt-computer-orchestrator:8090
}
```

Viewer: `https://siragpt.com/sessions/:id/novnc/…`. No DNS. No `computer.siragpt.com`.

Gateway routing is provisioned separately. The reviewed app and orchestrator publishers preserve the live gateway and do not rewrite or reload Caddy.

## 2. Compose — paste into `compose.yaml`

Add the service in `computer-orchestrator.compose.yaml` to `/home/user/deployments/iliagpt/compose.yaml`.

- `container_name` + `hostname`: **`siragpt-computer-orchestrator`**
- Same docker network as `iliagpt-backend` (usually `iliagpt-app`)
- `/var/run/docker.sock`
- `AGENT_COMPUTER_MAX_DESKTOPS` default **2** (not 8 — 8×1GB OOM'd this machine)
- `AGENT_COMPUTER_PUBLIC_BASE=https://siragpt.com`
- Build context: this repo's `services/computer-orchestrator` (same tree `publish.sh` already uses for backend)

On the **backend** service (if not already present):

```
AGENT_COMPUTER_ORCHESTRATOR_URL: http://siragpt-computer-orchestrator:8090
AGENT_COMPUTER_PUBLIC_BASE: https://siragpt.com
```

Do not set `computer.siragpt.com`.

## 3. Versioned orchestrator publication

`Publish production (Lenovo)` first requires successful CI for the exact target tree and the reviewed app publication. It then runs `publish-computer-orchestrator.sh` from that target, even if `/api/version` already reports the target SHA. A failed orchestrator verification fails the workflow; the app SHA alone is not proof that the desktop runtime was updated. The older `publish.sh.snippet` is a manual provisioning reference, not the production release path.

The companion acquires the same publication lock and requires a clean target checkout, healthy app readiness, one healthy existing `computer-orchestrator` service in project `iliagpt`, and agreement between its running immutable image ID and the configured image tag. It builds only the tracked `services/computer-orchestrator` tree using `git archive`. A source-tree label is accompanied by Git-blob checks of every installed top-level JavaScript module, the desktop entrypoint and desktop assets. Matching bytes, image identity and health permit a no-op.

Before activation, the candidate passes those byte checks and a fake-driver loopback health smoke in a read-only container without network egress, Docker socket, credentials, profiles or session creation. The script rechecks checkout, public release, configuration fingerprints, running container/image and tag after the build. Activation pins the immutable candidate image and updates only `computer-orchestrator` with `--no-deps --no-build --pull never`.

On failure, rollback restores the captured immutable previous image, activates only that service and verifies its health and image ID. A failed rollback is reported as critical. Private evidence stays under `backups/computer-<target>-*` with restricted permissions; command output is not replayed. Neither `.env` nor the installed Compose file is changed.

Existing user desktop containers, images and profiles are not recreated or restarted. Control-plane reconnection may briefly interrupt viewer connections. Runtime changes in the new orchestrator (such as CPU affinity on session reuse and the CDP transport) become available after it restarts and reconciles existing desktops. Changes to the desktop entrypoint or already-running Chromium/compositor processes require a separate reviewed recovery; this publisher does not silently restart user applications.

## 4. Verify after publication

```bash
docker exec iliagpt-backend getent hosts siragpt-computer-orchestrator
# POST /api/agent-computer/sessions → 200/201
# embedUrl starts with https://siragpt.com/sessions/…  (not computer.siragpt.com)
```
