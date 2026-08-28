# siragpt-computer-orchestrator

Persistent isolated Linux desktop per member+conversation. Hostname on the
iliagpt docker network is **`siragpt-computer-orchestrator:8090`**.

The viewer is served on **https://siragpt.com/sessions/:id/novnc/** (path
prefix). Do not use `computer.siragpt.com` or `computer.chatagic.com`. No DNS
change.

## Live Lenovo publish (not this repo's Caddy / compose)

Production does **not** use `deploy/Caddyfile`. The live gateway mounts
`/home/user/deployments/iliagpt/Caddyfile` (a `:80` file with `@sse` for
`/api/ai/generate*` `/api/ai/stream*` `/api/*/pending-stream*`; encode never
wraps SSE). Replacing that file with `deploy/Caddyfile` drops the stronger
SSE block and brings back the Pensando hang.

The only live Caddy edit is `handle /sessions/*` →
`siragpt-computer-orchestrator:8090` next to `@sse`. Snippet:
`deploy/iliagpt/sessions.handle.caddy`.

`publish.sh` (Lenovo only) builds runner / backend / frontend and will never
start this service until it is in `/home/user/deployments/iliagpt/compose.yaml`
and the script runs `build` + `up -d --no-deps`. See `deploy/iliagpt/`.

`AGENT_COMPUTER_MAX_DESKTOPS` default is **2** (8×1GB OOM'd the Lenovo).
`AGENT_COMPUTER_PUBLIC_BASE=https://siragpt.com`.

## Contract

- `POST /sessions { userId }` → create or reuse `{ sessionId, userId, reused }`
- `GET /sessions/:id`
- noVNC at `/sessions/:id/novnc/` (vnc.html + websockify)
- CDP HTTP/WS at `/sessions/:id/cdp`
- `POST /sessions/:id/agent/action`, `GET /sessions/:id/agent/screenshot`

Isolation is the `userId` the backend already sends (`member-key.js`
conversation suffix). Reuse; never spawn a new Chrome/VM per catalog click.

Each desktop container is `sira-ac-user-{slug}` with user `compuser`,
`DISPLAY=:1`, and memory/CPU caps (`AGENT_COMPUTER_DESKTOP_MEMORY_MB`,
`AGENT_COMPUTER_DESKTOP_CPUS`).
