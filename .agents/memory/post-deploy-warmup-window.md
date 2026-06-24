---
name: Post-deploy backend warmup window
description: Why /api/* returns raw 500 for ~90s after every publish, and the safe client-side pattern to handle it gracefully.
---

# Post-deploy backend warmup window

After every publish, the Next.js frontend goes live ~90s **before** the Express
backend finishes booting (migrations + plugins + DB). During that window every
`/api/*` call is proxied to a backend that isn't listening, so the Next.js
`afterFiles` rewrite returns a **raw 500** ("Internal Server Error"). Users hit
this most visibly on hard navigations like the Google OAuth button
(`window.location.href = .../api/auth/google`).

**Why it's by design:** the deploy health-check only probes the frontend port,
and start-all.cjs starts the frontend first on purpose so a slow backend boot
can't fail the promote. Do NOT make `/` depend on the backend and do NOT block
the deploy on backend readiness to "fix" this — that trades a cosmetic warmup
error for deploy failures.

**Safe readiness signal:** `HEAD /api/health/ready` is served by Next.js itself
(filesystem route beats the `/api/:path*` rewrite), pings the backend, and
returns **204 when live / 503 while warming**. It never returns the raw proxy
500, so it is safe to poll during warmup. `lib/use-backend-ready.ts` wraps this.

**How to apply:** for any user-facing action that hard-navigates to or fires an
`/api/*` request on auth/landing screens, gate it behind `useBackendReady()` —
queue the action while "warming" and auto-run it once "ready", showing a
"server starting, retrying" banner instead of letting the raw 500 surface.
