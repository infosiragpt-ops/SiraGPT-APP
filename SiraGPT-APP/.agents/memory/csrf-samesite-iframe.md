---
name: CSRF SameSite=Strict breaks in Replit dev iframe
description: SameSite=Strict CSRF cookies fail when app is previewed inside Replit's cross-site iframe; fix with SameSite=None;Secure for dev sidecar mode.
---

## Rule
When the app runs in the Replit dev preview (iframe inside replit.com), any cookie with `SameSite=Strict` or `SameSite=Lax` will NOT be sent on cross-site subrequests (fetch/XHR POSTs). The top-level URL is `replit.com`; the iframe origin is `*.riker.replit.dev` — these are different sites, so strict/lax cookies are blocked by the browser.

**Why:** `SameSite=Strict/Lax` block cookies on cross-site subrequests. `SameSite=None` with `Secure=true` is the only option that allows cookies in cross-site iframe contexts. This is a dev-only problem; production users access the app directly.

**How to apply:** Check `REPLIT_BACKEND_MODE === 'sidecar'` (set in the dev workflow) and switch CSRF cookies to `SameSite=None; Secure=true` when true. Leave production at `SameSite=Strict`.

Also: `SameSite=Lax` does NOT fix this — Lax still blocks cookies on cross-site POST/fetch subrequests (it only allows cookies on top-level GET navigations).

## SameSite=None;Secure is NOT enough — Safari ITP / 3rd-party cookie blocking
`SameSite=None;Secure` lets a browser *send* the cookie cross-site, but Safari (ITP) and Chrome's third-party-cookie phase-out **refuse to store** the cookie at all when the app is in a cross-site iframe. So the `_csrf_secret` httpOnly cookie never persists, never returns on the POST, and the double-submit check fails with `reason: missing_token` even though GET /csrf-token returned 200 just before. Symptom: csrf-token fetched OK, then every login/mutating POST is 403 `csrf_invalid` / `missing_token` in the canvas iframe (Safari especially).

**Why:** double-submit CSRF fundamentally depends on a cookie round-tripping. If the browser drops the cookie, no cookie-based scheme can work — independent of SameSite.

**The real fix — stateless self-signed token (see backend/src/middleware/csrf.js):**
- `issueCsrfToken` mints `<nonce>.<ts>.<sig>` where `sig = HMAC(nonce.ts, pepper)` (self-validating; ~138 chars, NOT 64-hex anymore).
- `requireCsrf` keeps double-submit as the PRIMARY path (header OR body token; safe because the un-readable httpOnly `_csrf_secret` cookie must round-trip).
- Stateless FALLBACK is honored **HEADER-ONLY** (`headerToken && verifyStatelessToken(headerToken)`), used when the secret cookie is absent OR stale-mismatched.

**CRITICAL — why header-only:** the stateless token is GLOBAL (signed but NOT session-bound), so an attacker can mint a valid one for themselves. Accepting it from a `_csrf`/`csrfToken` BODY field reopens CSRF — they replay it via a plain cross-site `<form>` POST (no preflight needed). A custom `X-CSRF-Token` header CANNOT be set cross-site without a CORS preflight, which the allowlist (`backend/src/middleware/cors-policy.js`) rejects for unknown origins. **This makes the fix depend critically on CORS: `CORS_ORIGINS=*` + credentials in production would defeat it** (index.js boots a `cors_wildcard_origin_in_production_csrf_risk` warning).

**Why:** double-submit needs a cookie round-trip; if the browser drops the cookie, only a header-delivered, CORS-gated token is safe. A global token in the body is NOT.

**Other guards:** `verifyStatelessToken` rejects future timestamps (>5min skew) and >24h-old tokens; pepper = `CSRF_PEPPER || JWT_SECRET` (a weak default would make tokens forgeable — ensure one is set in prod). Frontend treats the token as opaque (echoes `data.csrfToken` into `X-CSRF-Token`), so the format change is transparent to lib/api.ts.

## CORS corollary
`Access-Control-Allow-Headers` must include `X-CSRF-Token`, `X-CSRF-Retry`, and `Idempotency-Key` for browser preflights to succeed in cross-origin contexts (lib/next-api-cors.ts).
