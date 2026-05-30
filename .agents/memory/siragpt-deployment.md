---
name: siraGPT deployment architecture
description: Why siraGPT must run on Reserved VM, not Autoscale, and how its prod DB differs from executeSql.
---

# siraGPT deployment & data gotchas

## Deployment target: must be Reserved VM, NOT Autoscale
The backend is a heavy stateful monolith (BullMQ workers, schedulers, WebSocket
servers, in-process rate limiting, plugin/hermes runtime, model-sync). Boot loads
90+ route modules + AI SDKs + Prisma engine.

- Local boot (dev container): ~38s.
- Autoscale prod container: ~592s (~10 min) — ~15x slower due to CPU starvation
  during the synchronous require/boot phase.

**Why Reserved VM:** Autoscale cold-starts containers on demand and scales to
zero, so every cold start leaves `/api` returning ECONNREFUSED / "Internal Server
Error" for ~10 min until the backend finishes booting. A Reserved VM is always-on
with dedicated CPU: boot happens once at deploy, then stays up, and the heavy boot
is much faster on dedicated CPU.

**How to apply:** Deploy via `.replit` `[deployment] deploymentTarget` (this app is
NOT an artifact-based deploy — the artifact.toml files for mockup-sandbox/api-server
are skill scaffolding, not what ships). `.replit` is read-only to the agent, so the
user must switch type to Reserved VM in the Publish UI and republish.

Boot architecture: `backend/index.js` calls `startServer()` at the very bottom, so
`app.listen()` only fires after ALL module requires + ~700 lines of middleware
setup complete. The port cannot open until the whole module graph loads.

## Prod database != executeSql database
`executeSql` (code_execution) connects to a DIFFERENT database than the backend.
The backend uses DATABASE_URL/PRISMA_DATABASE_URL (Prisma Accelerate,
accelerate.prisma-data.net). To modify real app data, use the backend's Prisma
client: `node -e` with `./backend/node_modules/@prisma/client`. bcryptjs rounds=12.
Login flow needs CSRF: GET /api/auth/csrf-token then POST /api/auth/login with
X-CSRF-Token header + cookie jar; email normalized (lowercased).
