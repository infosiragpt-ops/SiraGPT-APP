---
name: CSRF SameSite=Strict breaks in Replit dev iframe
description: SameSite=Strict CSRF cookies fail when app is previewed inside Replit's cross-site iframe; fix with SameSite=None;Secure for dev sidecar mode.
---

## Rule
When the app runs in the Replit dev preview (iframe inside replit.com), any cookie with `SameSite=Strict` or `SameSite=Lax` will NOT be sent on cross-site subrequests (fetch/XHR POSTs). The top-level URL is `replit.com`; the iframe origin is `*.riker.replit.dev` — these are different sites, so strict/lax cookies are blocked by the browser.

**Why:** `SameSite=Strict/Lax` block cookies on cross-site subrequests. `SameSite=None` with `Secure=true` is the only option that allows cookies in cross-site iframe contexts. This is a dev-only problem; production users access the app directly.

**How to apply:** Check `REPLIT_BACKEND_MODE === 'sidecar'` (set in the dev workflow) and switch CSRF cookies to `SameSite=None; Secure=true` when true. Leave production at `SameSite=Strict`.

Also: `SameSite=Lax` does NOT fix this — Lax still blocks cookies on cross-site POST/fetch subrequests (it only allows cookies on top-level GET navigations).

## CORS corollary
`Access-Control-Allow-Headers` must include `X-CSRF-Token`, `X-CSRF-Retry`, and `Idempotency-Key` for browser preflights to succeed in cross-origin contexts (lib/next-api-cors.ts).
