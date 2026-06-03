---
name: OAuth callback URL policy
description: How Google OAuth redirect URIs are resolved and the silent same-host wrong-path trap.
---

# OAuth callback URL resolution (oauth-url-policy.js)

- `GOOGLE_AUTH_BASE_URL=https://siragpt.com` (shared env) is the single authoritative override; it short-circuits all heuristics so the single-domain (frontend + API on siragpt.com) config is honoured instead of an inferred `api.*` subdomain.
- Per-flow redirect secrets resolve via `buildCallbackUrl(env, key, path)`:
  - `GOOGLE_AUTH_URI` → google login `/api/auth/google/callback`
  - `GOOGLE_REDIRECT_URI` → gmail `/api/auth/gmail/callback`
  - `GOOGLE_REDIRECT_CALENDAR_DRIVE_URI` → google-services `/api/auth/google-services/callback`

## The same-host wrong-path trap (non-obvious)

`buildCallbackUrl` only overrides a configured per-flow URI when its **host** differs from the resolved backend host. A configured URI that is on the **right host** (siragpt.com) is accepted **verbatim**, including its path. So a per-flow secret with the correct host but the **wrong path** silently routes that flow to another flow's callback — there is NO guard against it and NO log.

**Why:** the cross-host guard was built to reject stale `api.siragpt.com` URIs; it was never meant to validate paths. Real incident: `GOOGLE_REDIRECT_URI` and `GOOGLE_REDIRECT_CALENDAR_DRIVE_URI` were swapped (each held the other's `siragpt.com` path), so gmail/google-services OAuth resolved to each other's callback with no warning.

**How to apply:** when a Google OAuth flow lands on the wrong callback but the host looks fine, suspect a swapped/mis-pathed per-flow URI secret, not the host-resolution logic. Verify each secret's path matches its `CALLBACK_PATHS` entry.

## "Google OAuth callback override ignored" log (passport.js)

- Fires only when `GOOGLE_AUTH_URI` (stripped) !== resolved google callback. It checks **only** GOOGLE_AUTH_URI, not the gmail/services secrets. When GOOGLE_AUTH_URI already matches the resolved URL, the log never fires regardless of the other two secrets' state.
