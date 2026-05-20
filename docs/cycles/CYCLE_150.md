# Cycle 150 — Half-Century-Past-Centenarian Milestone

**Date:** 2026-05-19
**Marker:** 150 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.4.0`, backend `1.3.0` (MINOR bumps — passes the
50-cycle landmark beyond the centenarian and lands a significant
security surface: WebAuthn / SAML / OIDC).

This document marks the cycles 141-150 consolidation — fifty cycles
past the centenarian. See the CHANGELOG `[0.4.0 / backend 1.3.0]`
section for the grouped entry and `docs/cycles/CYCLE_140.md` for the
previous milestone marker.

## Theme of the Band: Federated SSO + Operational Health

Cycles 141-150 expanded authentication into a federated, enterprise-
grade surface (WebAuthn / SAML / OIDC) with first-class provisioning,
identity-linking, and the operational health plumbing needed to keep
the multi-factor estate observable: TOTP setup telemetry, by-api-key
audit, cron health metrics, queue snapshots, and idle-detection sweeps
for both orgs and users.

## What Was Achieved

### WebAuthn / Passkey scaffold (cycle 141)
- **WebAuthn / Passkey scaffold (141)** — third-factor scaffold:
  challenge/registration/authentication endpoints, `WebAuthnCredential`
  storage, rpId/origin config.

### SAML response handler (cycle 142)
- **SAML response handler (142)** — SAML 2.0 IdP-initiated handler
  (signed-assertion verification, attribute mapping, replay nonce).

### OIDC handler + unified SSO dispatch (cycle 143)
- **OIDC handler + unified SSO dispatch (143)** — OIDC authorization-
  code flow + a unified `/sso/callback` dispatcher that fans out to
  SAML / OIDC / passkey handlers by provider key.

### SSO provisioning policies + SSOIdentity (cycle 144)
- **SSO provisioning policies + SSOIdentity (144)** — `SSOIdentity`
  model linking external `(provider, subject)` to local users; org-
  level just-in-time provisioning policies (auto-create / require-
  invite / deny).

### SSO identities list + unlink (cycle 145)
- **SSO identities list + unlink (145)** — `GET /me/sso/identities`
  surfaces linked external identities; `DELETE /me/sso/identities/:id`
  unlinks with re-auth gating + audit.

### `totpSetupInitiated` + audit `byApiKey` (cycle 146)
- **totpSetupInitiated + audit byApiKey (146)** — `totpSetupInitiated`
  telemetry counter for enrolment funnel; audit log now records the
  acting `byApiKey` when a request was authenticated via API key
  rather than a session.

### Cron health metrics + queues snapshot (cycle 147)
- **cron health metrics + queues health snapshot (147)** — per-job
  last-run / next-run / last-error / last-duration metrics; aggregate
  queue snapshot endpoint for the admin dashboard.

### Idle orgs detection (cycle 148)
- **idle orgs detection (148)** — sweep flags orgs with no member
  activity over a configurable window; surfaces in admin org list
  with `idleSince` + `idleDays`.

### Idle users detection (cycle 149)
- **idle users detection (149)** — sweep flags users with no session
  activity over a configurable window; powers the lifecycle UI.

### This marker (cycle 150)
- **This marker (150)** — milestone consolidation doc + CHANGELOG
  sweep + **MINOR** version bump to `0.4.0 / 1.3.0` (50-cycle landmark
  + significant security surface).

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~150** |
| Backend tests (Node `--test`) | **~2,000+** |
| Cron / scheduled jobs | **14+** |
| HTTP endpoints (public + admin) | **150+** |
| Multi-tenant (orgs + members + caps + CSV + stats + announcements + require-2FA + idle detection) | production-ready |
| Auth (JWT + API keys + revoke-all + password audit + invite-verify + SMS-2FA + TOTP-2FA + recovery codes + WebAuthn + SAML + OIDC + SSOIdentity) | production-ready |
| Federated SSO (SAML 2.0 + OIDC + unified dispatch + JIT provisioning + identity link/unlink) | production-ready |
| MFA (SMS via Twilio + TOTP RFC 6238 + recovery codes + partial-session + org-enforce + WebAuthn passkeys + setup telemetry) | production-ready |
| Operational health (cron metrics + queue snapshot + idle-org sweep + idle-user sweep + audit byApiKey) | production-ready |
| Lint ratchet | `--max-warnings 45` (held since cycle 60) |

## Notable Files Touched

- `backend/src/services/webauthn/*` — WebAuthn challenge / register / authenticate (141).
- `backend/src/routes/sso/saml-callback.js` — SAML 2.0 response handler (142).
- `backend/src/routes/sso/oidc-callback.js` — OIDC code-flow handler (143).
- `backend/src/routes/sso/dispatch.js` — unified `/sso/callback` provider dispatch (143).
- `backend/prisma/schema.prisma` — `WebAuthnCredential`, `SSOIdentity`, idle-flag columns (141, 144, 148, 149).
- `backend/src/services/sso/provisioning.js` — JIT provisioning policies (144).
- `backend/src/routes/me/sso-identities.js` — list + unlink (145).
- `backend/src/services/metrics/totp.js` — `totpSetupInitiated` counter (146).
- `backend/src/services/audit.js` — `byApiKey` field (146).
- `backend/src/services/cron/health.js` — per-job metrics (147).
- `backend/src/routes/admin/queues-health.js` — queue snapshot (147).
- `backend/src/jobs/idle-orgs-sweep.js` — idle org detection (148).
- `backend/src/jobs/idle-users-sweep.js` — idle user detection (149).

## What Comes Next (cycles 151+)

1. SCIM 2.0 user/group provisioning endpoint.
2. Step-up auth (require fresh 2FA for sensitive ops).
3. Trusted-device fingerprinting to skip 2FA on known devices.
4. Admin view of org-wide MFA / SSO enrolment coverage.
5. Just-in-time deprovisioning on SSO identity revoke.
6. Idle-account lifecycle policies (notify → suspend → archive).
