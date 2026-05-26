# src — source roots (bridge)

SiraGPT no usa un único `src/` en la raíz. Mapeo:

| Upstream `src/` | SiraGPT |
|---|---|
| Backend services | `backend/src/` |
| Shared lib | `lib/` |
| Frontend (App Router) | `app/` |

Agent runtime: `backend/src/services/agents/`
