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

## Replit injects PORT=5000 and routes external 80 to it — app MUST listen on PORT
In Reserved VM (and Autoscale) deployments, Replit injects `PORT=5000` into the
container and routes external port 80 to **that injected PORT**, regardless of what
`[[ports]]` declares as `localPort`. If the app listens on any other port (e.g.,
hard-coded 3000 via `FRONTEND_PORT=3000`), the health-check fails:
"a port configuration was specified but the required port was never opened, expected port 5000".

**Fix in `scripts/start-all.cjs`:** When `REPLIT_DEPLOYMENT=1`, resolve `FRONTEND_PORT`
as `process.env.PORT || process.env.FRONTEND_PORT || 3000` so the injected PORT wins
over the run-command's `FRONTEND_PORT=3000` override. In dev, FRONTEND_PORT takes
priority (keeps Next.js on 3000 as the dev workflow expects).

**Why:** The `.replit` run command hard-codes `FRONTEND_PORT=3000` for dev compatibility,
but in production Replit's container infrastructure injects PORT=5000 and routes to it.
The `[[ports]]` `localPort` declaration is only metadata; routing is driven by the
injected PORT env var.

## Reserved VM (& Autoscale) allow only ONE external port
A Reserved VM / Autoscale deployment exposes exactly ONE external port. `.replit`
must declare a single `[[ports]]` entry with `externalPort = 80`; the exposed
internal port must bind `0.0.0.0` (not localhost). Declaring more than one
`externalPort` makes the gce **promote/health-check step time out** (~4 min:
"Waiting for deployment to be ready") and the publish FAILS — even though the
build/compile phase succeeds. Autoscale tolerated extra ports (it only probes the
`:80` port); Reserved VM does not.

**Why:** SiraGPT's `.replit` historically declared 3 ports (3000→80 frontend,
5000→5000 sira-promo dev-only video, 5050→3000 backend). Only the frontend should
be external; the backend is reached via loopback `127.0.0.1:5050` (Next.js
rewrites) and sira-promo via the `/sira-promo` proxy through the frontend —
neither needs an external port. The dev-only 5000 never opens in prod, and 5050
exceeds the readiness window, so both block the VM promote.

**How to apply:** The agent CANNOT edit `.replit` `[[ports]]` — the edit guard
blocks it and there is NO agent callback for port mappings (verified: not in
code_execution, workflows, or any skill). The USER must remove the extra mappings
in the **Ports** pane, keeping only `3000 → 80`, then republish. The homepage
`GET /` probe is safe to keep on `/` because the root layout/page do no blocking
SSR backend fetch (generateMetadata only reads request headers), so `/` returns
200 fast while the backend finishes booting in the background.

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
