# SiraGPT sandbox microservice — deploy & architecture

The document agent (Cowork-style) needs a Docker host to run ephemeral, network-less
containers. The main app stays on **Replit, untouched** (domain, DB, deploy intact);
a dedicated server is "the muscle of the sandbox".

```
  ┌─────────────┐   HTTPS (Cloudflare Tunnel)   ┌──────────────────────────────┐
  │  SiraGPT    │  sandbox.chatagic.com         │  Lenovo (Ubuntu 22.04)       │
  │  (Replit)   │ ───────────────────────────▶  │  systemd: siragpt-sandbox    │
  │  doc-agent  │   Bearer SANDBOX_API_KEY       │  node server.js @127.0.0.1:4000│
  │  LOOP + LLM │                                │   └─ docker run (per session)│
  └─────────────┘                                │       siragpt-doc-sandbox    │
        ▲ remote-sandbox.js                       │       --network none, 1cpu,  │
        │ (proxies the 5 tools over HTTP)         │       1g, 100 pids, ephemeral│
        └─ collectOutputs → download cards        └──────────────────────────────┘
```

- The **agentic loop + the LLM key stay on the app** (Replit). Only **tool
  execution** happens on the Lenovo, inside a throwaway container.
- The app auto-selects the remote driver when `SANDBOX_SERVICE_URL` +
  `SANDBOX_API_KEY` are set (see `backend/src/services/doc-agent/sandbox.js`).
- Capacity: **15 concurrent containers** (32 vCPU host), 10-min TTL + GC.

## What this directory ships
- `server.js` — zero-dependency HTTP API (`/health` public; everything else Bearer).
- `lib/docker-sandbox.js` — one ephemeral container per session.
- `runner/Dockerfile` — the runner image (python-docx/openpyxl/python-pptx/pypdf/
  mammoth + LibreOffice headless), built as `siragpt-doc-sandbox:latest`.
- `siragpt-sandbox.service` — systemd unit (binds 127.0.0.1 only, auto-restart).
- `scripts/smoke.js` — post-deploy validation.
- `.env.example` — config template (the real `.env` lives only on the host).

## Server deploy (run on the Lenovo as `lenovo`)
One script does it all (idempotent, no secrets inside):
```bash
# transfer just this directory, then:
cd /home/lenovo/siragpt-sandbox
bash scripts/server-setup.sh            # add --harden-ssh to also lock down SSH
```
What it does (and what was done in production):
1. **Runner image** — `docker build -t siragpt-doc-sandbox:latest runner`.
2. **Config** — generates a strong `SANDBOX_API_KEY` into `.env` (chmod 600) and
   `~/secrets/lenovo-server.txt`.
3. **Service** — installs `siragpt-sandbox.service`, binds **127.0.0.1:4000**,
   `curl http://127.0.0.1:4000/health` → `{"ok":true,"docker":true,...}`.
4. **Dedicated tunnel** — creates a **separate named** cloudflared tunnel
   (`siragpt-sandbox`) with its OWN config (`~/.cloudflared/sandbox-config.yml`)
   and its OWN systemd unit (`cloudflared-sandbox.service`), routes
   `sandbox.chatagic.com` to it by explicit tunnel UUID, and runs it. The
   host's existing cloudflared config (SSH ingress + other sites) is **never
   touched** — a mistake here cannot break SSH access or the other tunnels.

> Why a separate tunnel and not an extra ingress in the shared config? The only
> way into this host is the Cloudflare SSH tunnel; corrupting the shared config
> would mean a permanent lockout. An isolated tunnel removes that risk entirely.

## Validate from anywhere
```bash
SANDBOX_SERVICE_URL=https://sandbox.chatagic.com SANDBOX_API_KEY=<key> \
  node services/sandbox/scripts/smoke.js     # → SMOKE PASS ✅
# /health is 200 without auth; any /v1/* is 401 without the Bearer, 200 with it.
```

## ⚠️ Final manual step — paste into Replit Secrets
The deploy prints these (also stored in `~/secrets/lenovo-server.txt` on the
Lenovo). Add them to the **Replit** app's Secrets so the doc-agent uses the
remote sandbox:

| Secret | Value |
|---|---|
| `SANDBOX_SERVICE_URL` | `https://sandbox.chatagic.com` |
| `SANDBOX_API_KEY` | `<the openssl-generated key>` |

No secrets are committed to the repo — only this template. Rotate the key by
regenerating `.env` on the host + updating the Replit Secret.

## Security posture
- The service binds **127.0.0.1** only; the sole public path is the Cloudflare
  Tunnel (HTTPS) which enforces nothing itself — the Bearer key is the gate.
- Every runner: `--network none` (no egress), 1 vCPU / 1 GB / 100 pids,
  `no-new-privileges`, non-root, auto-removed; per-command 120 s timeout;
  sessions destroyed on TTL (10 min) or `DELETE`.
- The host's own SSH hardening (key-only auth, fail2ban, unattended-upgrades)
  is documented in `scripts/server-setup.sh` and applied during deploy.
