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
a *genuinely* unreachable backend, not one unlucky probe. Four rules:
1. Only a **503 RESPONSE** from `HEAD /api/health/ready` counts toward `"warming"`
   (≥2 consecutive; counter resets on any 204). A **thrown** probe fetch — the 7s
   abort firing, or an iframe network blip — must NOT count: it does not prove the
   backend is down. **Why this matters:** the backend is a *separate process* and
   stays reachable even when the Next.js DEV server stalls the event loop
   compiling a heavy route (seen: `/code` = 63s, 15322 modules). That stall makes
   the filesystem probe route unanswerable → the browser probe aborts at 7s → a
   false `"warming"`. A genuine post-publish outage instead returns a *fast 503*
   (Next.js is up and answering; its `/health/live` ping is refused). 503-only
   keeps both cases correct.
2. The `HEAD /api/health/ready` route checks `/health/live` with a **3000ms**
   (not 1000ms) backend timeout — 1s false-503'd on transient slowness; 3s still
   fails fast on a real outage and is within the hook's 7s abort.
3. Auth pages compute `isWarming = backendState === "warming"` **only** — do NOT
   also raise it on `pendingAction` during the sub-second `"checking"` window, or
   a quick click flashes the alarming banner on a healthy backend. The queued
   action still flushes via the existing ready-effect; the Google button shows
   its own spinner via `pendingAction`.
4. **Never hard-gate the actual auth action on `backendState === "ready"`.** Gate
   only on `=== "warming"` (login/register/google in login+register pages). The
   old `!== "ready"` gate meant that while stuck in `"checking"` (which is exactly
   where the dev-compile stall leaves you), clicking "Iniciar sesión" only called
   `setPendingAction` and **never ran the login** — the button silently did
   nothing ("no me deja trabajar"). `"checking"` must proceed directly; the
   backend is reachable. Only a *confirmed* warmup defers + queues.

**Why:** users on the healthy DEV preview saw a persistent "El servidor se está
iniciando…" banner AND a dead login button even though the backend was up — the
real trigger was heavy dev route compilation stalling the probe, not a stuck
backend. The fix lives in `lib/use-backend-ready.ts` (503-only signal) and the
login/register page gates.
