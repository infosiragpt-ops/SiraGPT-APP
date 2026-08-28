# deploy — SiraGPT deployment

| Artefacto | Ruta |
|---|---|
| Docker production | `../Dockerfile` |
| Docker dev | `../Dockerfile.dev` |
| Compose | `../docker-compose.yml` |
| Infra bridges | `../infra/` (OpenClaw, Temporal, LiteLLM, CrewAI) |
| **Live Lenovo Caddy / computer orch** | `iliagpt/` — **not** `Caddyfile` |

Live gateway is `/home/user/deployments/iliagpt/Caddyfile` (`@sse` for
generate/stream/pending-stream). Do not replace it with repo `Caddyfile`.
Computer viewer: add `handle /sessions/*` only (`iliagpt/sessions.handle.caddy`).
Compose + `publish.sh` snippet: `iliagpt/`.

Health: `GET /api/hermes/health`, `GET /api/orchestration/health`
