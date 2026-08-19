# Cycle 140 — Fourth-Decade-Past-Centenarian Milestone

**Date:** 2026-05-19
**Marker:** 140 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.3.4`, backend `1.2.4` (PATCH bumps).

This document marks the cycles 131-140 consolidation — the fourth
decade past the centenarian. See the CHANGELOG `[0.3.4 / backend 1.2.4]`
section for the grouped entry and `docs/cycles/CYCLE_130.md` for the
previous milestone marker.

## Theme of the Band: SMS / 2FA / TOTP — Multi-Factor Authentication

Cycles 131-140 turned phone-based and time-based second-factor
authentication into a first-class subsystem: an SMS Twilio scaffold,
phone verification flow, SMS-2FA opt-in + login gate, TOTP scaffold +
TOTP login gate with `PartialSession`, partial-session sweep + TOTP
recovery codes, 2FA disable + `/me` flags, org-enforced 2FA
requirement, and finally this marker consolidation.

## What Was Achieved

### SMS Twilio scaffold (cycle 131)
- **SMS Twilio scaffold (131)** — Twilio provider wiring, env-driven
  config (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`),
  thin `sms.send()` service with isolated error handling.

### Phone verification + journey test fix (cycle 132)
- **phone verification + journey test fix (132)** — phone-number
  verification flow (challenge + verify endpoints, 6-digit OTP, TTL'd
  challenge store) plus a flaky journey test stabilised.

### 2FA SMS scaffold (cycle 133)
- **2FA SMS scaffold (133)** — SMS second-factor scaffold reusing the
  phone-verification primitives; `User.twoFactorSmsEnabled` flag and
  per-login OTP challenge persistence.

### 2FA opt-in + login gate (cycle 134)
- **2FA opt-in + login gate (134)** — opt-in endpoint to enable SMS
  2FA on the current account; login flow gated to require the SMS
  OTP step before issuing the session token.

### TOTP 2FA scaffold (cycle 135)
- **TOTP 2FA scaffold (135)** — RFC 6238 TOTP generator/verifier,
  secret provisioning (otpauth URI + QR-friendly payload),
  `User.twoFactorTotpSecret` storage.

### TOTP login gate + PartialSession (cycle 136)
- **TOTP login gate + PartialSession (136)** — login flow extended
  with a TOTP-required branch; intermediate `PartialSession` model
  carries the pre-2FA state until the second factor is provided.

### Partial-session sweep + TOTP recovery codes (cycle 137)
- **partial-session sweep + TOTP recovery codes (137)** — cron sweep
  expires stale `PartialSession` rows; one-time recovery codes
  generated at TOTP enrolment, hashed at rest, single-use on verify.

### 2FA disable + /me flags (cycle 138)
- **2FA disable + /me flags (138)** — disable endpoints for both SMS
  and TOTP factors (re-auth gated); `GET /me` exposes
  `twoFactorSmsEnabled` / `twoFactorTotpEnabled` flags for the UI.

### Org-enforce 2FA requirement (cycle 139)
- **org-enforce 2FA requirement (139)** — org-level setting
  `require2FA`; members without an enrolled second factor are
  blocked at login until they enrol, with grace-period support.

### This marker (cycle 140)
- **This marker (140)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.3.4 / 1.2.4`.

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~140** |
| Backend tests (Node `--test`) | **~2,000+** |
| Cron / scheduled jobs | **12+** |
| HTTP endpoints (public + admin) | **140+** |
| Multi-tenant (orgs + members + caps + CSV + stats + announcements + require-2FA) | production-ready |
| Auth (JWT + API keys + SSO scaffold + revoke-all + password audit + invite-verify + SMS-2FA + TOTP-2FA + recovery codes) | production-ready |
| Webhooks (v2 signing + rotate + grace + nonce replay + glob events + pagination + toggle + latency + user-cap + announcement triggers) | production-ready |
| Announcements (CRUD + pagination + PUT + reads + unread + critical bulk email + sweep) | production-ready |
| User notifications (inbox + mark-read + sweep + webpush-critical) | production-ready |
| MFA (SMS via Twilio + TOTP RFC 6238 + recovery codes + partial-session + org-enforce) | production-ready |
| Rate limiting (per-IP + per-key + payload-size + endpoint usage) | production-ready |
| Observability (metrics, traces, audit sampling, forecast alerts, webhook latency, org stats) | production-ready |
| Lint ratchet | `--max-warnings 45` (held since cycle 60) |

## Notable Files Touched

- `backend/src/services/sms/twilio.js` — Twilio provider + `sms.send()` (131).
- `backend/src/routes/auth/phone-verify.js` — phone verification endpoints (132).
- `backend/src/services/2fa/sms.js` — SMS 2FA challenge/verify (133, 134).
- `backend/src/routes/auth/login.js` — SMS-2FA + TOTP login gates + PartialSession branch (134, 136).
- `backend/src/services/2fa/totp.js` — RFC 6238 TOTP generator/verifier (135).
- `backend/prisma/schema.prisma` — `PartialSession`, `twoFactorTotpSecret`, `twoFactorRecoveryCode`, `Org.require2FA` (136, 137, 139).
- `backend/src/jobs/partial-session-sweep.js` — expiry cron (137).
- `backend/src/services/2fa/recovery-codes.js` — hashed one-time recovery codes (137).
- `backend/src/routes/auth/2fa-disable.js` — disable endpoints + re-auth (138).
- `backend/src/routes/me.js` — `twoFactorSmsEnabled` / `twoFactorTotpEnabled` flags (138).
- `backend/src/middleware/org-require-2fa.js` — org-level enforcement (139).

## What Comes Next (cycles 141+)
1. WebAuthn / passkeys as a third factor option.
2. Backup-codes regenerate + per-code audit trail.
3. Trusted-device fingerprinting to skip 2FA on known devices.
4. Step-up auth (require fresh 2FA for sensitive ops).
5. Admin view of org-wide 2FA enrolment coverage.
6. SMS provider abstraction (Twilio + MessageBird + Vonage bridges).
