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
```bash
# 1. code
mkdir -p /home/lenovo/siragpt-sandbox && cd /home/lenovo/siragpt-sandbox
#   (rsync just services/sandbox/* here — see scripts/server-setup.sh)

# 2. runner image
docker build -t siragpt-doc-sandbox:latest runner

# 3. config: strong key (ALSO saved to ~/secrets/lenovo-server.txt)
KEY=$(openssl rand -hex 32)
cp .env.example .env && sed -i "s/^SANDBOX_API_KEY=.*/SANDBOX_API_KEY=$KEY/" .env

# 4. service
sudo cp siragpt-sandbox.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now siragpt-sandbox
curl -s http://127.0.0.1:4000/health    # → {"ok":true,"docker":true,...}

# 5. tunnel ingress (add to the EXISTING cloudflared config; do NOT touch the
#    SSH ingress). In ~/.cloudflared/config.yml under `ingress:`:
#      - hostname: sandbox.chatagic.com
#        service: http://localhost:4000
#    then: cloudflared tunnel route dns <TUNNEL> sandbox.chatagic.com
#    sudo systemctl restart cloudflared
```

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
