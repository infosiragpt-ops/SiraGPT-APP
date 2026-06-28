---
name: Privileged /api endpoints belong on the backend, not as local Next route handlers
description: Why a local app/api/*/route.ts for a privileged action is dangerous in this Next+Express split, and the safe pattern.
---

# Privileged /api endpoints must fall through the rewrite, never be a local Next handler

In this app, `next.config.mjs` has an `afterFiles` rewrite `/api/:path* -> ${backendBase}/api/:path*`. `afterFiles` means a filesystem route (e.g. `app/api/publishing/route.ts`) matches FIRST and OVERRIDES the rewrite; only paths with no Next route fall through to Express.

**Rule:** Any privileged/auth-requiring `/api` endpoint must be served by the Express backend (mounted behind `authenticateToken`/`requireAdmin`) and reach it via the rewrite. Do NOT implement it as a local `app/api/.../route.ts`.

**Why:**
1. A local route handler runs in Next with no backend auth — it silently bypasses the Express auth gate (this is exactly how the publishing console became a public unauthenticated deploy trigger).
2. Hand-proxying from a local route to the backend is also a trap: `backend/src/middleware/auth.js` validates a session fingerprint via `computeFingerprint(req)` built from `user-agent` + client-IP headers (`cf-connecting-ip`, `true-client-ip`, `x-forwarded-for`, `x-real-ip`, `forwarded`). A custom `fetch` that forwards only cookie/authorization makes the backend fingerprint the undici server request (127.0.0.1 / server UA) instead of the browser → `fingerprint_mismatch` → session revoked → **admin lockout**. The unauth curl test does not catch this.

**How to apply:** To close such a hole, DELETE the local `route.ts` and let `/api/<x>` fall through to the `afterFiles` rewrite — the same transport login uses, so all headers (UA/IP) are preserved and the fingerprint matches. Verify with unauth curl → 401 AND keep header fidelity for the admin path. CSRF note: the admin console (`components/code/publishing-console.tsx`) uses plain `fetch` and does NOT attach the double-submit token (only the `lib/api.ts` ApiClient does), so adding `requireCsrf` to such a route breaks the console until the console is switched to the ApiClient.
