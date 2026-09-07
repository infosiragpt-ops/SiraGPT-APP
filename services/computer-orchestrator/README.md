# siragpt-computer-orchestrator

Persistent isolated Linux desktop per member+conversation. Hostname on the
iliagpt docker network is **`siragpt-computer-orchestrator:8090`**.

The viewer is served on **https://siragpt.com/sessions/:id/novnc/** (path
prefix). Do not use `computer.siragpt.com` or `computer.chatagic.com`. No DNS
change.

## Cloudflare prerequisite (verified 2026-09-07)

The noVNC viewer needs a real WebSocket to
`/sessions/:id/novnc/websockify`. If the Cloudflare edge does not forward
`Upgrade: websocket` to origin, the orchestrator receives a plain GET,
websockify answers its Python 404 page, and every viewer hangs forever on
"Connecting…" / "Preparando escritorio…" — while the desktop itself, the
orchestrator, Caddy and the WS proxy are all healthy (each verified
individually end to end). Symptom fingerprint: `curl` with Upgrade headers
to the websockify path returns websockify's `Error response / 404 / Nothing
matches the given URI` page instead of `101 Switching Protocols`.
Fix: Cloudflare dashboard → the zone → Network → **WebSockets ON** (and no
WAF/Transform rule stripping `Upgrade` headers). No code change can work
around a stripped upgrade: RFB needs a real socket.

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

## Always-on behavior

Desktops are never reaped by the orchestrator: containers run with
`RestartPolicy: unless-stopped`, and on (re)boot the server reconciles every
running `sira-ac-user-*` container back into the session store
(`reconcileContainers`, logged as `computer_orchestrator_reconciled`), so a
restart, deploy or host reboot never orphans a live computer.

The viewer completes the loop client-side
(`components/code/department-computer-pane.tsx`,
`components/desktop/DesktopScreen.tsx`): session acquire retries with
backoff (transport/5xx only, never isolation/auth), cached sessions are
revalidated before use, the RFB channel reconnects a bounded number of
times, and a 60 s heartbeat rebuilds the session after consecutive misses.
When everything fails the pane shows the real error with a Reintentar
button instead of spinning "Preparando escritorio…" forever. The agent
drives the same container through `POST /api/agent-computer/action`
(conversation-bound identity), so viewer and agent always share one computer.

## Desktop look (Grok Bot)

`start-desktop.sh` seeds XFCE + Plank so a **new** session first-paints as
an empty gray-fabric desktop: no xfce4-panel, no maze wallpaper, no
auto-opened Chrome window. Plank at the bottom has exactly three
launchers (Google Chrome, Thunar, Terminal). Chrome still listens on
CDP `:9222` via `--no-startup-window`.

**Already-running** `sira-ac-user-*` containers keep the previous look
until they are recreated (rebuild the orchestrator image and replace
those session containers). Do not `compose down -v` just to refresh the
wallpaper.
