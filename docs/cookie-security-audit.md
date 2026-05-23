# Cookie Security Audit — Improvement Cycle 51

Date: 2026-05-19

## Scope
Audit every cookie issued by the backend Express app and evaluate whether
`sameSite` can be tightened from the current value without breaking
top-level redirect flows (OAuth, magic-link, payment callbacks).

## Inventory

| Cookie | Issuer | httpOnly | secure (prod) | sameSite (before) | sameSite (after) | Notes |
|--------|--------|----------|---------------|-------------------|------------------|-------|
| `token` (session) | `backend/src/routes/auth.js` (login, register, refresh) | yes | yes | `lax` | `lax` (unchanged) | Must survive top-level navigation back from Google OAuth callback. `strict` would log out users after the OAuth round-trip. |
| `csrf-token` (public, JS-readable) | `backend/src/middleware/csrf.js` (`csrfTokenRoute`) | no | yes | `lax` | **`strict`** | Issued on-demand by the SPA. Never needs to survive cross-site top-level navigation — the SPA re-fetches a fresh token on load. |
| `csrf-secret` (HMAC pair) | `backend/src/middleware/csrf.js` (`csrfTokenRoute`) | yes | yes | `lax` | **`strict`** | Same lifecycle as the public token; tightened in lock-step. |
| `anon` (anonymous tracking) | `backend/src/middleware/trackAnonUsage.js` | (default) | yes | `lax` (or `none` when `CROSS_ORIGIN_ANON` env set) | `lax` (unchanged) | Intentionally configurable to `none` for cross-origin embed scenarios; tightening would break those. |

## Decision
Tightened `csrf-token` and `csrf-secret` to `sameSite: 'strict'`.

### Rationale
1. The CSRF double-submit pattern operates entirely on same-origin XHR/fetch.
   The cookies are read and echoed back by the SPA in a header on the same
   origin — they never need to ride a cross-site GET.
2. If a user lands on the SPA via a cross-site link, `strict` simply means
   the *previous* CSRF cookie is not sent on that first navigation. The SPA
   detects this and calls `GET /api/csrf-token` to mint a new pair before
   any state-mutating request. No user-visible effect.
3. Strict closes a class of attacks where a same-site (but different
   subdomain or downgraded scheme) origin could leak the token through a
   cross-site request that `lax` would still attach.

### Why auth `token` stays at `lax`
Google OAuth (and any other 3rd-party identity provider) issues a top-level
`302` redirect back to our origin. With `sameSite: 'strict'`, the freshly
issued session cookie would be withheld on that redirect and the user would
appear logged-out on first paint. `lax` is the correct, documented choice
for session cookies that participate in third-party identity flows.

## Verification
- `backend/tests/csrf.test.js` — existing CSRF middleware tests pass with the new flag.
- `npm run lint` — clean against the new ratchet (45).
- Manual smoke: SPA calls `GET /api/csrf-token` on bootstrap; subsequent
  `POST` requests succeed via the `X-CSRF-Token` header.

## Files Changed
- `backend/src/middleware/csrf.js` — `sameSite: 'lax'` → `'strict'` with inline justification comment.
