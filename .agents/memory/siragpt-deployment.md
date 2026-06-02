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
are skill scaffolding, not what ships). `.replit` may be filesystem-writable, but the
deployment *type* (Autoscale vs Reserved VM) is selected in the Publish UI — there is
no clean `.replit` deploymentTarget value for Reserved VM (docs: it's a UI/machine-config
choice). So the user must switch type to Reserved VM in the Publish UI and republish.
This is also a billing change (Reserved VM = always-on fixed cost) — get user consent.

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

## OAuth callback URL fix
Production env var `GOOGLE_AUTH_BASE_URL=https://siragpt.com` prevents
`inferBackendUrlFromFrontend` from prepending `api.` to FRONTEND_URL and
producing `https://api.siragpt.com/api/auth/google/callback`. Also set
`GOOGLE_ALLOW_FRONTEND_CALLBACK=true` as belt-and-suspenders. Both set as
production-only env vars. In dev, OAuth still shows the warning (expected).

## Key secrets needing user action
- `SESSION_SECRET`: Replit secret is 23 chars; minimum is 32. Changing it
  invalidates all existing user sessions. User must update via Replit Secrets UI.
- `CORS_ORIGINS`: Replit secret is `*`; should be `https://siragpt.com,...`.
  User must update via Replit Secrets UI.

## Dev workflow packages
Root `node_modules` is empty by default in this repo. Run `pnpm install` first
(finishes in ~5s when global pnpm store is warm). Then restart the workflow.
The workflow uses `npx next dev` which requires packages to be installed.
If `npx next dev` still fails: update workflow command to use `node_modules/.bin/next`.
