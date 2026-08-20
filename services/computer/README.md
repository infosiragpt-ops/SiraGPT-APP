# SiraGPT agent computer

Per-session XFCE + Chrome desktop for the Grok-bot-style agent loop.
Maps to `/opt/siragpt/services/computer` on the VPS.

This is **not** the always-on CEO Office webtop (`sira-dpc-*`). Those
containers must stay running. The 30-minute TTL and the reaper apply
only to `sira-acomp-*` sessions created here.

## What it is

1. **Image** (`Dockerfile`) — Ubuntu 22.04, Xvfb `:1` 1366×768, XFCE,
   x11vnc, noVNC/websockify, Google Chrome, Node agent on `:8080`.
2. **In-image agent** (`agent/`) — `/screenshot`, `/action` (zod +
   `execFile` argv only), `/files` (confined to `/workspace`), `/health`.
3. **Orchestrator** (`orchestrator/`) — dockerode, one container per
   session, 2 GB / 2 CPU / 1 GB shm, **not privileged**, `CapDrop: ALL`
   plus the documented Chrome/Xvfb caps, Bearer `COMPUTER_ORCH_SECRET`.
4. **Agent loop** (`backend/src/services/computer/agent-loop.js`) —
   DeepSeek V4 Flash / Pro only. **cdpMode** (Playwright CDP +
   accessibility tree text) is the default because those models do not
   accept images on this stack. Screenshot loop runs only when the
   model is listed in `COMPUTER_VISION_MODELS`.

## Enable the viewer

Unset / `0` keeps the existing Selkies/PNG department pane.

```
NEXT_PUBLIC_AGENT_COMPUTER=1
# and/or
SIRAGPT_AGENT_COMPUTER=1
COMPUTER_ORCH_URL=http://127.0.0.1:18080
COMPUTER_ORCH_SECRET=<random>
```

Rebuild the Next.js app after changing `NEXT_PUBLIC_*`.

## Build and run (VPS)

```bash
cd /opt/siragpt/services/computer
docker build -t siragpt-computer:latest .
cd orchestrator && npm ci
export COMPUTER_ORCH_SECRET=... COMPUTER_IMAGE=siragpt-computer:latest
node server.js
```

Chrome flags (required): `--no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222`.

## Caps (not privileged)

After `CapDrop: ALL` the orchestrator adds only what Chrome + Xvfb need
on Ubuntu 22.04: `SYS_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`,
`SETPCAP`, `DAC_OVERRIDE`, `FOWNER`, `CHOWN`, `MKNOD`, `AUDIT_WRITE`,
`KILL`. Documented in `orchestrator/sessions.js`.

## Public URL

Use **`computer.siragpt.com`** (Cloudflare tunnel is ops on the VPS,
not this PR). Do not configure `computer.chatagic.com`.

`COMPUTER_NOVNC_BASE_URL=https://computer.siragpt.com`

## Tests

```bash
# always-on unit tests (no Docker)
cd backend && node --test tests/agent-computer-loop.test.js \
  tests/agent-computer-agent.test.js tests/agent-computer-orchestrator.test.js

# live Docker + pixelmatch — skipped if Docker or the image is missing
node --test tests/agent-computer-docker.test.js
```

## Models

Only `deepseek-v4-flash` and `deepseek-v4-pro` via
`https://api.deepseek.com` (`DEEPSEEK_API_KEY`). No OpenRouter / OpenAI
/ Anthropic / CopilotKit.
