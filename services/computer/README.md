# siragpt-computer

Una maquina Linux persistente POR MIEMBRO (label userId). Agentes de todos los depts de ese usuario la comparten.

Human viewer: Xvfb -> x11vnc -> websockify/noVNC (clics reales). PNG solo para el loop del agente.

## Layout
- Dockerfile: ubuntu:22.04 + supervisor + xfce + chrome + agent
- orchestrator: POST /sessions (owner persistente restart=always + volume /workspace)
- kind=ephemeral: TTL 30 min + reaper (CI/test only)
- No se tocan sira-dpc-* webtops

## Env (append a /opt/siragpt/.env.example, no borrar .env)
SIRAGPT_AGENT_COMPUTER=0
AGENT_COMPUTER_ORCHESTRATOR_URL=http://127.0.0.1:8090
AGENT_COMPUTER_IMAGE=siragpt-computer:local
AGENT_COMPUTER_PUBLIC_BASE=http://127.0.0.1:8090

## Cloudflare / DNS
Hostname: computer.siragpt.com (NO chatagic.com).
cloudflared systemd: inactive. TLS lo hace Caddy en siragpt.com.
No se anadio ingress a Caddy para no romper siragpt.com.
Falta: A/AAAA computer.siragpt.com -> 62.72.11.231 (Luis Cloudflare 2FA).
Snippet: Caddyfile.computer.snippet

## Orchestrator
127.0.0.1:8090  (compose --no-deps, no reemplaza frontend/backend)

## Humano
Abrir novncUrl (vnc.html + websockify). No usar screenshot como viewer.
