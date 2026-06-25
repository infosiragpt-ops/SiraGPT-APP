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

**Banner false-positive guard (don't regress):** the warmup banner must reflect
a *genuinely* unreachable backend, not one unlucky probe. Three rules:
1. `useBackendReady` only flips to `"warming"` after **≥2 consecutive** probe
   failures (counter resets to 0 on any success). A single slow/aborted probe —
   cold-start route compile, GC pause, transient blip, the first probe of a fresh
   page load — must stay in `"checking"` (no banner). A real outage is
   ECONNREFUSED → 2 fast failures within ~1 poll (~2.5s), so warmup detection
   latency stays well under the ~90s window.
2. The `HEAD /api/health/ready` route checks `/health/live` with a **3000ms**
   (not 1000ms) backend timeout — 1s false-503'd on transient slowness; 3s still
   fails fast on a real outage and is within the hook's 7s abort.
3. Auth pages compute `isWarming = backendState === "warming"` **only** — do NOT
   also raise it on `pendingAction` during the sub-second `"checking"` window, or
   a quick click flashes the alarming banner on a healthy backend. The queued
   action still flushes via the existing ready-effect; the Google button shows
   its own spinner via `pendingAction`.

**Why:** users on the healthy DEV preview saw a persistent "El servidor se está
iniciando…" banner even though server-side `HEAD /api/health/ready` returned 204
in ~40ms every time and dev logs proved the browser's own probe succeeded — it
was a transient flash on each page mount / login retry, not a stuck backend.
