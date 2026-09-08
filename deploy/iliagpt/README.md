# Lenovo iliagpt — computer orchestrator (live publish)

Production publish does **not** use repo `deploy/Caddyfile`.

| Live path (Lenovo) | Role |
|---|---|
| `/home/user/deployments/iliagpt/Caddyfile` | Gateway config (`iliagpt-gateway`). `:80` file with `@sse` for `/api/ai/generate*` `/api/ai/stream*` `/api/*/pending-stream*`. `encode` never wraps SSE. |
| `/home/user/deployments/iliagpt/compose.yaml` | Compose project **`iliagpt`** (`iliagpt-backend`, `iliagpt-runner`, `iliagpt-frontend`, `iliagpt-gateway`). |
| `publish.sh` (Lenovo only — not in this repo) | Builds **runner backend frontend** and force-recreates gateway from the **iliagpt** Caddyfile. |

**Do not** copy `deploy/Caddyfile` over the live file. That drops the stronger `@sse` block and brings back the Pensando hang.

`publish.sh` will never start `siragpt-computer-orchestrator` until the service is in `compose.yaml` and the script builds/ups it with `--no-deps`.

## 1. Caddy — only live edit

Leave `@sse` and `encode` untouched. Next to that block, add the handle from `sessions.handle.caddy`:

```
handle /sessions/* {
	reverse_proxy siragpt-computer-orchestrator:8090
}
```

Viewer: `https://siragpt.com/sessions/:id/novnc/…`. No DNS. No `computer.siragpt.com`.

`publish.sh` already force-recreates gateway from this file, so the handle is picked up on the next publish. Reloading Caddy without replacing the file is also fine.

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

## 3. `publish.sh` — add after runner/backend/frontend

`publish.sh` is only on the Lenovo. Append the lines in `publish.sh.snippet` (`build` + `up -d --no-deps`). No `compose down -v`. No `git reset --hard`.

## 4. Verify (after a human publish — this PR must not publish)

```bash
docker exec iliagpt-backend getent hosts siragpt-computer-orchestrator
# POST /api/agent-computer/sessions → 200/201
# embedUrl starts with https://siragpt.com/sessions/…  (not computer.siragpt.com)
```
