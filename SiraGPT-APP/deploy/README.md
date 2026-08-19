# deploy — SiraGPT deployment

| Artefacto | Ruta |
|---|---|
| Docker production | `../Dockerfile` |
| Docker dev | `../Dockerfile.dev` |
| Compose | `../docker-compose.yml` |
| Infra bridges | `../infra/` (OpenClaw, Temporal, LiteLLM, CrewAI) |

Health: `GET /api/hermes/health`, `GET /api/orchestration/health`
