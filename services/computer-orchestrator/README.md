# siragpt-computer-orchestrator

Persistent isolated Linux desktop per member+conversation. Hostname on the
iliagpt docker network is **`siragpt-computer-orchestrator:8090`**.

The viewer is served on **https://siragpt.com/sessions/:id/novnc/** (Caddy
path prefix). Do not use `computer.siragpt.com` or `computer.chatagic.com`.

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
