# SiraGPT agent computer

One persistent XFCE + Chrome desktop **per SiraGPT member**. All department
agents of that user share it (work surfaces, not a security boundary).
Maps to `/opt/siragpt/services/computer` on the VPS.

This is **not** the always-on CEO Office webtop (`sira-dpc-*`). Those
containers must stay running. This service never lists, stops, or recreates
them.

Pattern rewritten in-tree (Xvfb + x11vnc + websockify/noVNC + xdotool).
Do not vendor anthropic-quickstarts, linuxserver/webtop, or m1k1o/neko.
KasmVNC / WebRTC (neko) is optional later.

## Product model

| Rule | Detail |
|---|---|
| Key | SiraGPT `userId` (one container) |
| Not a key | Department / bot / task |
| User | `compuser` (non-root), workdir `/workspace` |
| Artifacts | `/workspace/<task-id>/` |
| Human viewer | noVNC (real mouse/keyboard over VNC→WebSocket) |
| Agent loop | PNG or CDP text → DeepSeek → xdotool (`execFile`) |
| PNG | Control loop only — not the human UI |
| Persist | Named Docker volume `sira-acomp-ws-<hash>` on `/workspace` |
| Idle reclaim | Off by default (`COMPUTER_IDLE_RECLAIM=1` to enable) |

## What it is

1. **Image** (`Dockerfile`) — Ubuntu 22.04, Xvfb `:1` 1366×768, XFCE,
   Thunar, xfce4-terminal, x11vnc, noVNC/websockify, Google Chrome,
   Node agent on `:8080`.
2. **In-image agent** (`agent/`) — `/screenshot`, `/action` (zod +
   `execFile` argv only), `/files` (confined to `/workspace`),
   `POST /tasks` (`/workspace/<task-id>/`), `/health`.
3. **Orchestrator** (`orchestrator/`) — dockerode, **get-or-create one
   container per `userId`**, 2 GB / 2 CPU / 1 GB shm, **not privileged**,
   `CapDrop: ALL` plus the documented Chrome/Xvfb caps, Bearer
   `COMPUTER_ORCH_SECRET`.
4. **Agent loop** (`backend/src/services/computer/agent-loop.js`) —
   DeepSeek V4 Flash / Pro only. Max 25 steps; abort if the same action
   repeats 3 times; JSON log per step. **cdpMode** (Playwright CDP +
   accessibility tree text) is the default because those models do not
   accept images on this stack. Screenshot loop runs only when the
   model is listed in `COMPUTER_VISION_MODELS`. No OpenRouter.

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
cd backend && npm run test:agent-computer

# live Docker + pixelmatch — skipped if Docker or the image is missing
node --test tests/agent-computer-docker.test.js
```

## Models

Only `deepseek-v4-flash` and `deepseek-v4-pro` via
`https://api.deepseek.com` (`DEEPSEEK_API_KEY`). No OpenRouter / OpenAI
/ Anthropic / CopilotKit.
