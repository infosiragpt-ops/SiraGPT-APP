# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and improvement cycles follow a sequential number with the date the work landed.

## [0.4.3 / backend 1.3.3] — Cycles 171-180 milestone — 2026-05-20

Eighth decade past the centenarian. **PATCH** bumps (root
`0.4.2 → 0.4.3`, backend `1.3.2 → 1.3.3`) — a small celebratory
ten-cycle marker. Cycles 171-180 expanded admin audit search, prisma
schema validation, service-worker hardening, bundle analyzer, and a
broad rate-limit sweep across API keys, webhooks, Slack, invites, and
announcements. No public API breaks. See `docs/cycles/CYCLE_180.md`
for the milestone narrative.

### Added
- **Cycle 180 — milestone consolidation**: `docs/cycles/CYCLE_180.md`
  marker doc + CHANGELOG cycles 171-180 sweep + PATCH version bump to
  `0.4.3 / 1.3.3` (small celebratory ten-cycle marker; no public API
  breaks).
- **Cycle 179 — announcement create rate limit**: per-org rate limit
  on announcement create to prevent broadcast spam against members.
- **Cycle 178 — invite create+accept rate limits**: rate limits on
  invite create + accept to harden onboarding flow against
  enumeration and spam.
- **Cycle 177 — org Slack rate limits**: rate limits on org Slack
  webhook configure / test endpoints with audit emit on 429.
- **Cycle 176 — webhook create+delete rate limits**: rate limits on
  webhook create + delete to absorb misbehaving integrations or
  scripted abuse.
- **Cycle 175 — org API key rate limits**: per-IP + per-user rate
  limits applied to API-key create/rotate/revoke endpoints with
  structured 429 responses and audit emit.
- **Cycle 174 — SW hardening + bundle analyzer**: service worker
  cache versioning + safer fetch fallback; `@next/bundle-analyzer`
  wired behind an env flag for on-demand bundle introspection.
- **Cycle 173 — prisma format + schema-validate test**:
  `prisma format` applied across `schema.prisma`; new test asserts
  the formatted file is canonical and a schema validity check runs in
  CI.
- **Cycle 172 — per-org audit search**:
  `GET /orgs/:id/audit-logs/search` scoped to a single org with
  filter by actor, action, tag, time range, and free-text on
  payload; RBAC-gated to org owners and admins.
- **Cycle 171 — /admin/audit-logs/search endpoint**: global admin
  audit search across orgs with filter by actor, action, tag, time
  range, and free-text on payload.

### Changed
- Root `package.json` `0.4.2 → 0.4.3` and `backend/package.json`
  `1.3.2 → 1.3.3` (**PATCH**; small celebratory ten-cycle marker; no
  public API breaks).
- Lint ratchet held at `--max-warnings 44`.

## [0.4.2 / backend 1.3.2] — Cycles 161-170 milestone — 2026-05-20

Seventh decade past the centenarian. **PATCH** bumps (root
`0.4.1 → 0.4.2`, backend `1.3.1 → 1.3.2`) — a small celebratory
ten-cycle marker. Cycles 161-170 expanded observability metrics, cron
admin surface, org-transfer governance, audit-log tag indexing and
CSV export, and org-scoped broadcast notifications. No public API
breaks. See `docs/cycles/CYCLE_170.md` for the milestone narrative.

### Added
- **Cycle 170 — milestone consolidation**: `docs/cycles/CYCLE_170.md`
  marker doc + CHANGELOG cycles 161-170 sweep + PATCH version bump to
  `0.4.2 / 1.3.2` (small celebratory ten-cycle marker; no public API
  breaks).
- **Cycle 169 — org-scoped broadcast notifications**:
  `POST /orgs/:id/broadcast` fans out a notification to all org
  members with delivery tracking and per-member dismiss.
- **Cycle 168 — writeAuditLog tags + 5 critical writers tagged**:
  `writeAuditLog` accepts `tags: string[]`; 5 critical writers (auth,
  org-transfer, billing, api-key, webhook) emit structured tags for
  the new byTags filter.
- **Cycle 167 — audit-query.byTags filter**: `auditQuery.byTags([...])`
  filters audit rows by tag intersection; backed by a tag index for
  fast lookup.
- **Cycle 166 — org audit-logs CSV export**:
  `GET /orgs/:id/audit-logs.csv` streams the org audit log as CSV
  with quota integration from cycle 158.
- **Cycle 165 — pending transfer sweep + list endpoint**: periodic
  sweep expires stale pending transfers; admin list endpoint surfaces
  all pending transfers with filter by org / recipient / state.
- **Cycle 164 — org transfer approval policy + OrgPendingTransfer**:
  org ownership transfers require recipient approval;
  `OrgPendingTransfer` model holds pending state with TTL.
- **Cycle 163 — cron nextRuns helper + admin extension**: `nextRuns()`
  helper computes the next N firings per job; admin cron-jobs page
  surfaces upcoming schedule for forecasting.
- **Cycle 162 — API key request histogram + active gauge**: per-key
  request latency histogram + active-keys gauge with labels for org,
  status, and route family.
- **Cycle 161 — org members gauge metric**: Prometheus gauge tracking
  active members per org with periodic refresh, exposed on
  `/metrics`.

### Changed
- Root `package.json` `0.4.1 → 0.4.2` and `backend/package.json`
  `1.3.1 → 1.3.2` (**PATCH**; small celebratory ten-cycle marker; no
  public API breaks).
- Lint ratchet held at `--max-warnings 44`.

## [0.4.1 / backend 1.3.1] — Cycles 151-160 milestone — 2026-05-20

Sixth decade past the centenarian. **PATCH** bumps (root
`0.4.0 → 0.4.1`, backend `1.3.0 → 1.3.1`) — a small celebratory
ten-cycle marker. Cycles 151-160 hardened org-level governance:
retention sweeps, webhook DLQ + bulk ops, API-key bulk admin,
provider preference + cost caps, audit retention/export quotas, and
an org activity feed. No public API breaks. See
`docs/cycles/CYCLE_160.md` for the milestone narrative.

### Added
- **Cycle 160 — milestone consolidation**: `docs/cycles/CYCLE_160.md`
  marker doc + CHANGELOG cycles 151-160 sweep + PATCH version bump to
  `0.4.1 / 1.3.1` (small celebratory ten-cycle marker; no public API
  breaks).
- **Cycle 159 — org activity feed**: unified
  `GET /orgs/:id/activity` feed merges audit, webhook, member, and
  billing events into a single paginated stream with type filters.
- **Cycle 158 — per-org audit retention + export quota**: per-org
  audit retention window override and monthly export quota with usage
  counter and admin override.
- **Cycle 157 — org AI provider preference + cost cap**: orgs can pin
  a preferred AI provider (with fallback) and set a monthly cost cap
  with soft-warn / hard-stop thresholds.
- **Cycle 156 — webhook maxRetries + filters**: per-webhook
  `maxRetries` override (defaults to org policy) and event-type /
  status filters for the admin webhook listing.
- **Cycle 155 — webhook bulk toggle + delete**: admin endpoints to
  bulk enable/disable and bulk delete org webhooks with confirmation
  and audit trail.
- **Cycle 154 — api-keys bulk-revoke + CSV**: admin can bulk-revoke
  API keys by selection or filter and export the inventory to CSV
  with redacted secrets.
- **Cycle 153 — org webhook DLQ + retry**: failed webhook deliveries
  land in a per-org dead-letter queue with admin retry endpoint and
  delivery-attempt history.
- **Cycle 152 — audit archive 3y sweep + cron jobs admin**: audit
  rows older than the 3-year retention horizon are archived to cold
  storage; admin cron jobs page surfaces last-run / next-run / state.
- **Cycle 151 — stale SystemSettings sweep**: periodic sweep prunes
  orphaned / unreferenced SystemSettings rows and emits a janitor
  metric for the admin dashboard.

### Changed
- Root `package.json` `0.4.0 → 0.4.1` and `backend/package.json`
  `1.3.0 → 1.3.1` (**PATCH**; small celebratory ten-cycle marker; no
  public API breaks).
- Lint ratchet held at `--max-warnings 44` (tightened from 45).

## [0.4.0 / backend 1.3.0] — Cycles 141-150 milestone — 2026-05-19

Half-century past the centenarian. **MINOR** bumps (root
`0.3.4 → 0.4.0`, backend `1.2.4 → 1.3.0`) — the 50-cycle landmark
lands alongside a significant federated-security surface (WebAuthn /
SAML / OIDC) plus operational-health plumbing (cron + queue metrics,
idle-org / idle-user detection). No public API breaks. See
`docs/cycles/CYCLE_150.md` for the milestone narrative.

### Added
- **Cycle 150 — milestone consolidation**: `docs/cycles/CYCLE_150.md`
  marker doc + CHANGELOG cycles 141-150 sweep + MINOR version bump to
  `0.4.0 / 1.3.0` (50-cycle landmark + federated-security additions).
- **Cycle 149 — idle users detection**: sweep flags users with no
  session activity over a configurable window; powers the lifecycle
  UI with `idleSince` + `idleDays`.
- **Cycle 148 — idle orgs detection**: sweep flags orgs with no member
  activity over a configurable window; surfaces in admin org list
  with `idleSince` + `idleDays`.
- **Cycle 147 — cron health metrics + queues snapshot**: per-job
  last-run / next-run / last-error / last-duration metrics, plus
  aggregate queue snapshot endpoint for the admin dashboard.
- **Cycle 146 — totpSetupInitiated + audit byApiKey**:
  `totpSetupInitiated` telemetry counter for the TOTP enrolment
  funnel; audit log now records the acting `byApiKey` when a request
  was authenticated via API key rather than a session.
- **Cycle 145 — SSO identities list + unlink**:
  `GET /me/sso/identities` surfaces linked external identities;
  `DELETE /me/sso/identities/:id` unlinks with re-auth gating + audit.
- **Cycle 144 — SSO provisioning policies + SSOIdentity**: `SSOIdentity`
  model links external `(provider, subject)` to local users; org-level
  just-in-time provisioning policies (auto-create / require-invite /
  deny).
- **Cycle 143 — OIDC handler + unified SSO dispatch**: OIDC
  authorization-code flow + a unified `/sso/callback` dispatcher that
  fans out to SAML / OIDC / passkey handlers by provider key.
- **Cycle 142 — SAML response handler**: SAML 2.0 IdP-initiated
  handler with signed-assertion verification, attribute mapping, and
  replay-nonce protection.
- **Cycle 141 — WebAuthn / Passkey scaffold**: third-factor scaffold —
  challenge / registration / authentication endpoints,
  `WebAuthnCredential` storage, rpId / origin config.

### Changed
- Root `package.json` `0.3.4 → 0.4.0` and `backend/package.json`
  `1.2.4 → 1.3.0` (**MINOR**; 50-cycle landmark + federated-security
  surface; no public API breaks).
- Lint ratchet held at `--max-warnings 45` (unchanged since cycle 60).

## [0.3.4 / backend 1.2.4] — Cycles 131-140 milestone — 2026-05-19

Fourth decade past the centenarian. PATCH bumps only (root
`0.3.3 → 0.3.4`, backend `1.2.3 → 1.2.4`) — cycles 131-140 turned
phone-based and time-based second-factor authentication into a
first-class subsystem with no public API breaks. See
`docs/cycles/CYCLE_140.md` for the milestone narrative.

### Added
- **Cycle 140 — milestone consolidation**: `docs/cycles/CYCLE_140.md`
  marker doc + CHANGELOG cycles 131-140 sweep + PATCH version bump to
  `0.3.4 / 1.2.4`.
- **Cycle 139 — org-enforce 2FA requirement**: org-level setting
  `require2FA`; members without an enrolled second factor are blocked
  at login until they enrol, with grace-period support.
- **Cycle 138 — 2FA disable + /me flags**: disable endpoints for both
  SMS and TOTP factors (re-auth gated); `GET /me` exposes
  `twoFactorSmsEnabled` / `twoFactorTotpEnabled` flags for the UI.
- **Cycle 137 — partial-session sweep + TOTP recovery codes**: cron
  sweep expires stale `PartialSession` rows; one-time recovery codes
  generated at TOTP enrolment, hashed at rest, single-use on verify.
- **Cycle 136 — TOTP login gate + PartialSession**: login flow
  extended with a TOTP-required branch; intermediate `PartialSession`
  model carries the pre-2FA state until the second factor is provided.
- **Cycle 135 — TOTP 2FA scaffold**: RFC 6238 TOTP generator /
  verifier, secret provisioning (otpauth URI + QR-friendly payload),
  `User.twoFactorTotpSecret` storage.
- **Cycle 134 — 2FA opt-in + login gate**: opt-in endpoint to enable
  SMS 2FA on the current account; login flow gated to require the SMS
  OTP step before issuing the session token.
- **Cycle 133 — 2FA SMS scaffold**: SMS second-factor scaffold reusing
  phone-verification primitives; `User.twoFactorSmsEnabled` flag and
  per-login OTP challenge persistence.
- **Cycle 132 — phone verification + journey test fix**: phone-number
  verification flow (challenge + verify endpoints, 6-digit OTP, TTL'd
  challenge store) plus a flaky journey test stabilised.
- **Cycle 131 — SMS Twilio scaffold**: Twilio provider wiring,
  env-driven config (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM`), thin `sms.send()` service with isolated error
  handling.

### Changed
- Root `package.json` `0.3.3 → 0.3.4` and `backend/package.json`
  `1.2.3 → 1.2.4` (PATCH; no public API breaks).
- Lint ratchet held at `--max-warnings 45` (unchanged since cycle 60).

## [0.3.3 / backend 1.2.3] — Cycles 121-130 milestone — 2026-05-19

Third decade past the centenarian. PATCH bumps only (root
`0.3.2 → 0.3.3`, backend `1.2.2 → 1.2.3`) — cycles 121-130 turned
org-internal broadcast and user-level inbox plumbing into first-class
subsystems with no public API breaks. See `docs/cycles/CYCLE_130.md`
for the milestone narrative.

### Added
- **Cycle 130 — milestone consolidation**: `docs/cycles/CYCLE_130.md`
  marker doc + CHANGELOG cycles 121-130 sweep + PATCH version bump to
  `0.3.3 / 1.2.3`.
- **Cycle 129 — notification sweep + webpush critical**: cron sweep
  archives notifications past their `expiresAt`; `critical`-severity
  notifications additionally trigger web push delivery to subscribed
  devices (best-effort, isolated from inbox write).
- **Cycle 128 — user notifications inbox**: per-user `Notification`
  model + inbox endpoints (`GET /me/notifications`, mark-read,
  mark-all-read), decoupled from announcement reads so direct/system
  notifications share the surface.
- **Cycle 127 — announcement /reads + /unread**:
  `GET /org/announcements/:id/reads` (admin view of read receipts)
  and `GET /org/announcements/unread` (current user's unread list).
- **Cycle 126 — announcement reads + ack trigger**:
  `OrgAnnouncementRead` junction table tracking per-user read receipts;
  `org.announcement.ack` webhook trigger emitted on mark-read.
- **Cycle 125 — announcement pagination + PUT**: cursor pagination on
  the announcement listing; `PUT /org/announcements/:id` for full
  updates (alongside existing PATCH for partial fields).
- **Cycle 124 — accept-needs-verif fix + announcement sweep**: fix
  for the invite-accept path requiring email verification before
  membership; expired announcements swept by cron and archived
  without losing the audit trail.
- **Cycle 123 — announcement trigger + critical bulk email**:
  announcement publish emits `org.announcement.published` webhook;
  `critical` severity announcements fan out via batched, rate-limited
  bulk email to all org members.
- **Cycle 122 — OrgAnnouncement model + endpoints**: new Prisma
  model (title, body, severity, `scheduledAt`, `expiresAt`) + CRUD
  endpoints under `/org/announcements`.
- **Cycle 121 — pagination audit + sessions**: repo-wide listing
  audit for missing cursor pagination; sessions listing converted to
  cursor pagination so admin UIs never hit unbounded result sets.

### Changed
- Root `package.json` `0.3.2 → 0.3.3` and `backend/package.json`
  `1.2.2 → 1.2.3` (PATCH; no public API breaks).
- Lint ratchet held at `--max-warnings 45` (unchanged since cycle 60).

## [0.3.2 / backend 1.2.2] — Cycles 111-120 milestone — 2026-05-19

Second decade past the centenarian. PATCH bumps only (root
`0.3.1 → 0.3.2`, backend `1.2.1 → 1.2.2`) — cycles 111-120 hardened
rate-limiting, webhooks and API-key lifecycle plus org observability
with no public API breaks. See `docs/cycles/CYCLE_120.md` for the
milestone narrative.

### Added
- **Cycle 120 — milestone consolidation**: `docs/cycles/CYCLE_120.md`
  marker doc + CHANGELOG cycles 111-120 sweep + PATCH version bump to
  `0.3.2 / 1.2.2`.
- **Cycle 119 — webhook pagination + toggle**: cursor pagination on
  the webhook listing plus per-webhook enable/disable toggle without
  losing configuration or delivery history.
- **Cycle 118 — API keys pagination + search**: cursor pagination +
  name search on the API keys listing so admin UIs scale to large
  fleets.
- **Cycle 117 — webhook user cap + org stats**: per-user webhook
  quota enforced at create-time; new `/org/stats` endpoint summarises
  members, API keys, webhooks, sessions and recent activity.
- **Cycle 116 — revoke-all sessions + password audit**: single
  endpoint to revoke all of a user's active sessions; password
  change/reset events recorded in the audit trail with source IP and
  user-agent.
- **Cycle 115 — forecast alerts + webhook latency**: cost/usage
  forecaster emits alerts when projected month-end spend exceeds
  budget; webhook delivery latency captured per attempt and surfaced
  in the health endpoint.
- **Cycle 114 — trigger unknown guard + endpoint usage**: webhook
  trigger emission validates events against the registered catalogue
  and refuses unknown events; per-endpoint usage counters expose
  hot/cold routes.
- **Cycle 113 — payload-size + ApiKey soft-delete**: explicit
  per-route payload size guard with friendly 413 responses; ApiKey
  deletion is soft (tombstone + `deletedAt`) preserving audit linkage.
- **Cycle 112 — webhook glob events + nonce replay**: webhook
  subscriptions accept glob event patterns; inbound webhook receivers
  persist nonces and reject replays within the freshness window.
- **Cycle 111 — per-key rate limit + audit sampling**: per-API-key
  RPS budget on top of the existing per-IP limiter; configurable
  audit log sampling rate.

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 111-120.
- Root `package.json` version `0.3.1 → 0.3.2` (PATCH).
- Backend `package.json` version `1.2.1 → 1.2.2` (PATCH).
- Outbound webhook subscriptions support glob event patterns (cycle 112).
- ApiKey deletion semantics changed to soft-delete with tombstone
  (cycle 113) — listings exclude tombstones by default.

### Fixed
- Webhook replay attacks within the signature freshness window
  rejected via persisted nonce store (cycle 112).
- Unknown webhook trigger events no longer silently emit — explicit
  guard refuses them (cycle 114).
- Webhook delivery latency was previously invisible; now captured
  per attempt (cycle 115).

### Security
- Per-API-key RPS limit prevents single-key abuse (cycle 111).
- Webhook nonce replay defence (cycle 112).
- Per-route payload-size guard prevents oversized-body DoS (cycle 113).
- Webhook trigger unknown-event guard prevents typo-driven event
  injection (cycle 114).
- Revoke-all sessions endpoint enables incident response (cycle 116).
- Password change/reset events now in audit trail with IP + UA
  (cycle 116).
- Per-user webhook cap prevents quota exhaustion by a single user
  (cycle 117).

## [0.3.1 / backend 1.2.1] — Cycles 101-110 milestone — 2026-05-19

First decade past the centenarian. PATCH bumps only (root
`0.3.0 → 0.3.1`, backend `1.2.0 → 1.2.1`) — cycles 101-110 deepened
org tenancy, communications and lifecycle polish with no public API
breaks. See `docs/cycles/CYCLE_110.md` for the milestone narrative.

### Added
- **Cycle 110 — milestone consolidation**: `docs/cycles/CYCLE_110.md`
  marker doc + CHANGELOG cycles 101-110 sweep + PATCH version bump to
  `0.3.1 / 1.2.1`.
- **Cycle 109 — bulk invite + members CSV**: bulk-invite endpoint
  accepting a list of emails with per-row validation + partial
  success; members list exportable as CSV for admin offboarding/audit.
- **Cycle 108 — org member plan caps + /limits endpoint**: per-plan
  member caps enforced at invite-time; new `/limits` endpoint exposes
  current org quotas and usage in a single call.
- **Cycle 107 — email prefs + retry queue**: per-user notification
  preferences (categories opt-in/out) and a retry queue for transient
  SMTP failures with backoff + DLQ.
- **Cycle 106 — removal + ownership transfer emails**: dedicated
  templates for removal-from-org and ownership-transfer events with
  auditable context.
- **Cycle 105 — org member email notifications**: invites, accepts
  and role changes trigger templated email notifications to affected
  members + org admins.
- **Cycle 104 — webhook secret grace + inactive API key sweeps**:
  rotated webhook secrets accept the previous secret during a grace
  window; inactive API keys auto-disabled after a configurable idle
  period.
- **Cycle 103 — webhook secret rotate + v2 algorithm**: rotate
  endpoint plus stronger v2 HMAC signing algorithm for outbound
  webhooks.
- **Cycle 102 — OTel user attrs + budget hard enforce**: user/org IDs
  propagated as OTel span attributes; budget thresholds now hard-stop
  AI calls instead of soft-warning.
- **Cycle 101 — ApiKey sweep + usedScopes**: periodic sweep tracking
  the set of scopes actually exercised by each API key (`usedScopes`),
  surfacing over-permissioned keys.

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 101-110.
- Root `package.json` version `0.3.0 → 0.3.1` (PATCH).
- Backend `package.json` version `1.2.0 → 1.2.1` (PATCH).
- Outbound webhook signatures default to v2 HMAC (cycle 103).
- Budget enforcement is now hard-stop instead of soft-warn (cycle 102).

### Fixed
- Over-permissioned API keys are now visible via `usedScopes` (cycle 101).
- Transient SMTP failures no longer drop notifications — retried with
  backoff and DLQ (cycle 107).
- Inactive API keys no longer linger indefinitely (cycle 104).

### Security
- API keys auto-disabled after configurable idle period (cycle 104).
- Webhook secret rotation with grace window prevents delivery gaps
  while preserving rotation hygiene (cycles 103, 104).
- Stronger v2 HMAC algorithm for webhook signing (cycle 103).
- Budget hard-stop prevents runaway AI spend (cycle 102).
- OTel user attribution improves forensic traceability (cycle 102).

## [0.3.0 / backend 1.2.0] — Cycles 91-100 CENTENARIAN milestone — 2026-05-19

Centenarian marker — **100 continuous improvement cycles**. MINOR
version bumps to celebrate the milestone (root `0.2.5 → 0.3.0`, backend
`1.1.5 → 1.2.0`). Cycles 91-100 closed the auth + tenancy + cost +
observability story with no public API breaks. See
`docs/cycles/CYCLE_100.md` for the milestone narrative.

### Added
- **Cycle 100 — CENTENARIAN milestone consolidation**:
  `docs/cycles/CYCLE_100.md` marker doc + CHANGELOG cycles 91-100 sweep
  + MINOR version bump to `0.3.0 / 1.2.0`.
- **Cycle 99 — cost 13-month archive + 3-layer report**: `CostUsageDaily`
  trimmed to a rolling 13-month window with older months archived;
  unified three-layer report (snapshot + summary + trend) under
  `/admin/system-report`.
- **Cycle 98 — CostUsageDaily persistence + merged reports**: daily
  cost rollups persisted in `CostUsageDaily` instead of recomputed;
  admin cost/usage reports merged into a single response shape.
- **Cycle 97 — webhook DLQ + system-snapshot**: failed webhook
  deliveries land in a dead-letter queue with replay endpoint;
  `/admin/system-snapshot` returns a point-in-time JSON capture of
  platform state.
- **Cycle 96 — SSO domain claim + verify-email rate limit**: orgs can
  claim email domains for SSO routing (DNS TXT verified);
  `verify-email` and `resend` endpoints rate-limited per IP + per email.
- **Cycle 95 — system-summary + budget alerts**: `/admin/system-summary`
  aggregates orgs, users, jobs, RPS, cost in one call; per-org budget
  alerts when monthly spend crosses configured thresholds.
- **Cycle 94 — verif token sweep + emailVerified /me**: scheduled
  cleanup of expired/used verification tokens; `/me` returns
  `emailVerified` so the UI can gate features.
- **Cycle 93 — email verification flow**: signed verification tokens,
  `POST /auth/verify-email`, resend cooldown, and `emailVerified`
  timestamp on the User record.
- **Cycle 92 — cost forecast + cron stale alerts**: linear projection
  of monthly AI spend from rolling daily usage; cron heartbeat tracker
  flags jobs missing their expected cadence.
- **Cycle 91 — API key rotate + webhook health**: `POST /api-keys/:id/rotate`
  issues a new secret keeping id and scopes; webhook health endpoint
  surfaces success/failure rates per subscriber.

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 91-100.
- Root `package.json` version `0.2.5 → 0.3.0` (MINOR for milestone).
- Backend `package.json` version `1.1.5 → 1.2.0` (MINOR for milestone).
- Admin cost/usage reports merged into a single response shape (cycle 98).

### Fixed
- Cron jobs that miss their cadence are now detected and alerted (cycle 92).
- Cost rollups no longer recomputed on every report request (cycle 98).
- Stability fixes carried in feature cycles. See individual cycle
  entries for specifics.

### Security
- Email verification tokens with signed payloads + expiry sweep (cycles 93, 94).
- Per-IP + per-email rate limit on `verify-email` + `resend` (cycle 96).
- SSO domain claim with DNS TXT verification (cycle 96).
- API key rotation without losing id/scopes (cycle 91).
- Webhook DLQ prevents silent failure of outbound deliveries (cycle 97).

### Removed
- `CostUsageDaily` rows older than 13 months trimmed to archive (cycle 99).

## [0.2.5 / backend 1.1.5] — Cycles 81-90 milestone — 2026-05-19

Ninth-decade marker. Patch bumps only (root `0.2.4 → 0.2.5`, backend
`1.1.4 → 1.1.5`) — cycles 81-90 focused on settings hardening, export
integrity, cost observability and SSO scaffolding with no public API
breaks. See `docs/cycles/CYCLE_90.md` for the milestone narrative.

### Added
- **Cycle 90 — milestone consolidation**: `docs/cycles/CYCLE_90.md`
  marker doc + CHANGELOG cycles 81-90 sweep + version bump to
  `0.2.5 / 1.1.5`.
- **Cycle 89 — requireScope + API key counter**: `requireScope`
  middleware enforces per-route scope clearance; per-API-key invocation
  counter for rate + usage analytics.
- **Cycle 88 — API keys org-scoped + bearer fallthrough**: API keys
  carry `orgId` and scope authorization; bearer auth falls through to
  API key when JWT absent.
- **Cycle 87 — SSO scaffold + cost-tracker edges**: SAML and OIDC route
  stubs returning 501 Not Implemented; cost-tracker edge cases
  (negative duration, zero tokens, missing model) hardened.
- **Cycle 86 — AI cost alerts + SSE metrics**: threshold-based AI cost
  alert notifier; SSE channel metrics (open/close/heartbeat) surfaced.
- **Cycle 85 — members cache + usage-trend**: short-TTL cache for member
  rosters; `usage-trend` endpoint exposes per-org trend deltas.
- **Cycle 84 — maintenance metric + locale drift detector**:
  maintenance-mode short-circuits emit metric; locale drift detector
  flags missing/extra keys across translation bundles.
- **Cycle 83 — GDPR export metrics + SearchPanel retry**: counters and
  histograms for GDPR export jobs; SearchPanel UI gains retry on
  transient failure.
- **Cycle 82 — export integrity SHA-256 + CSRF in login/register**:
  exports emit SHA-256 manifest for tamper detection; CSRF tokens
  enforced on login + register flows.
- **Cycle 81 — zod settings + member activity**: strict zod schema
  validation for org settings JSON; per-member activity feed surfacing
  recent actions.

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 81-90.
- Root `package.json` version `0.2.4 → 0.2.5`.
- Backend `package.json` version `1.1.4 → 1.1.5`.

### Fixed
- Cost-tracker edge cases hardened (cycle 87).
- Stability fixes carried in feature cycles. See individual cycle
  entries for specifics.

### Security
- CSRF tokens on login + register (cycle 82).
- Export integrity SHA-256 manifests (cycle 82).
- Zod schema validation on org settings (cycle 81).
- API key org-scoping + scope-based authorization (cycles 88, 89).
- SSO scaffolding stubs returning 501 until promoted (cycle 87).

### Removed
- None in cycles 81-90.

## [0.2.4 / backend 1.1.4] — Cycles 71-80 milestone — 2026-05-19

Eighth-decade marker. Patch bumps only (root `0.2.3 → 0.2.4`, backend
`1.1.3 → 1.1.4`) — cycles 71-80 focused on org lifecycle, billing and
governance surface with no public API breaks. See
`docs/cycles/CYCLE_80.md` for the milestone narrative.

### Added
- **Cycle 80 — milestone consolidation**: `docs/cycles/CYCLE_80.md`
  marker doc + CHANGELOG cycles 71-80 sweep + version bump to
  `0.2.4 / 1.1.4`.
- **Cycle 79 — metadata.orgId augment + SSE events**: request metadata
  augmented with resolved `orgId` for every authenticated request; SSE
  event envelope carries org scope for downstream consumers.
- **Cycle 78 — org audit feed + settings JSON**: per-org audit feed
  endpoint with cursor pagination; freeform settings JSON blob per org
  with schema validation.
- **Cycle 77 — invitation lifecycle hooks**: pre/post hooks for invite
  create/accept/revoke with audit + Slack notification fan-out.
- **Cycle 76 — ownership transfer + leave**: atomic ownership transfer
  with at-least-one-owner invariant; member leave flow with re-assignment.
- **Cycle 75 — org billing upgrade + summary**: upgrade flow endpoint
  with plan transitions and prorated handling; per-org billing summary.
- **Cycle 74 — top-models + org Slack**: `top-models` analytics endpoint
  ranking model usage per org; per-org Slack webhook notifier for
  high-signal events.
- **Cycle 73 — audit archive + role-gated flags**: older AuditLog rows
  archived to cold table; feature flag toggles guarded by role clearance.
- **Cycle 72 — maintenance mode + quarterly export**: global maintenance
  flag short-circuits writes with friendly 503; quarterly export job
  dumps aggregated usage to long-term storage.
- **Cycle 71 — job-utils retry**: shared retry helper for scheduled jobs
  with exponential backoff + jitter and audit-logged final failures.

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 71-80.
- Root `package.json` version `0.2.3 → 0.2.4`.
- Backend `package.json` version `1.1.3 → 1.1.4`.

### Fixed
- Stability fixes carried in feature cycles. See individual cycle entries
  for specifics (no standalone fix-only cycle in this band).

### Security
- Role-gated feature flag toggles (cycle 73).
- Ownership-transfer invariant guard (cycle 76).
- Invitation lifecycle hooks with audit fan-out (cycle 77).
- Org settings JSON schema validation (cycle 78).

### Removed
- None in cycles 71-80.

## [0.2.3 / backend 1.1.3] — Cycles 61-70 milestone — 2026-05-19

Seventh-decade marker. Patch bumps only (root `0.2.2 → 0.2.3`, backend
`1.1.2 → 1.1.3`) — cycles 61-70 were lifecycle hygiene, multi-tenant
scoping, and OTel depth with no public API breaks. See
`docs/cycles/CYCLE_70.md` for the milestone narrative.

### Added
- **Cycle 70 — milestone consolidation**: `docs/cycles/CYCLE_70.md`
  marker doc + CHANGELOG cycles 61-70 sweep + version bump to
  `0.2.3 / 1.1.3`.
- **Cycle 69 — HTTP span middleware + RPS wiring**: central OTel HTTP
  span middleware wrapping every `/api/*` route with route template,
  status, duration; per-org RPS gauge wired from middleware.
- **Cycle 68 — OTel spans + per-org RPS**: extra spans across AI
  request lifecycle; per-org requests-per-second gauge exported on
  `/metrics`.
- **Cycle 67 — SSE resume + prompt-injection detector**: resumable SSE
  with `Last-Event-ID` replay window; lightweight prompt-injection
  heuristic detector wired into chat ingress.
- **Cycle 66 — byOrg audit filter + session list/revoke**: audit query
  `byOrg` filter with clearance check; admin endpoints to list active
  sessions per user and revoke individual session tokens.
- **Cycle 65 — org-scoped webhooks + cost groupBy=org**: webhook
  signing keys + delivery bound to org; cost endpoint
  `groupBy=org` aggregation.
- **Cycle 64 — cron health probe + onboarding cache**:
  `/api/admin/cron/health` last-run + status per scheduled job;
  onboarding cache layer for first-load cold paths.
- **Cycle 63 — AuditLog actorId index + featureFlags**: composite
  index on `(actorId, createdAt desc)`; feature flag service with
  per-org overrides and TTL cache.
- **Cycle 62 — hourly session sweep**: sweep job collapsing idle
  sessions and evicting expired records from session-manager.
- **Cycle 61 — ApiUsage prune 90d job**: scheduled cron deleting
  ApiUsage rows older than 90 days (configurable via
  `SIRAGPT_APIUSAGE_TTL_DAYS`).

### Changed
- Lint ratchet held at `--max-warnings 45` across cycles 61-70.
- Root `package.json` version `0.2.2 → 0.2.3`.
- Backend `package.json` version `1.1.2 → 1.1.3`.

### Fixed
- Stability fixes carried in feature cycles. See individual cycle entries
  for specifics (no standalone fix-only cycle in this band).

### Security
- Prompt-injection detector wired into chat ingress (cycle 67).
- byOrg audit filter with clearance check (cycle 66).
- Org-scoped webhook signing keys + delivery policies (cycle 65).
- Session list + revoke admin endpoints (cycle 66).

### Removed
- None in cycles 61-70.

## [0.2.2 / backend 1.1.2] — Cycles 51-60 milestone — 2026-05-19

Sixth-decade marker. Patch bumps only (root `0.2.1 → 0.2.2`, backend
`1.1.1 → 1.1.2`) — cycles 51-60 were security hardening, observability,
and admin UX with no public API breaks. See `docs/cycles/CYCLE_60.md`
for the milestone narrative.

### Added
- **Cycle 60 — milestone consolidation**: `docs/cycles/CYCLE_60.md`
  marker doc + CHANGELOG cycles 51-60 sweep + version bump to
  `0.2.2 / 1.1.2`.
- **Cycle 59 — search filters**: advanced FTS filter params (date range,
  type, owner, tag) across documents + chats + artifacts.
- **Cycle 58 — bookmark folders**: nested folder model + drag-reorder API
  + per-folder ACLs.
- **Cycle 57 — AI metrics Prometheus**: `ai_*` counters/histograms
  (tokens, latency, cost, failover trips) exported on `/metrics`.
- **Cycle 56 — rotate-secret**: `scripts/rotate-jwt-secret.js` +
  `/api/admin/security/rotate-secret` with dual-key grace window.
- **Cycle 55 — webhook verifier**: HMAC `X-Sira-Signature` + timestamp
  skew check + replay nonce cache for all inbound webhooks.
- **Cycle 54 — audit CSV**: `/api/admin/audit/export.csv` streaming
  exporter with column allow-list and row-level redaction.
- **Cycle 53 — MTD trend endpoints**: month-to-date aggregations for
  `agentTaskTrend`, `signupTrend`, `uploadTrend` admin charts.
- **Cycle 52 — CORS validation**: strict origin allow-list with regex +
  wildcard subdomain support and explicit deny logging.
- **Cycle 51 — CSRF strict**: double-submit cookie hardened to
  `SameSite=Strict` + per-session token rotation + state-changing
  method enforcement on all `/api/*` mutating routes.

### Changed
- Lint ratchet tightened `49 → 45` across cycles 51-60.
- Root `package.json` version `0.2.1 → 0.2.2`.
- Backend `package.json` version `1.1.1 → 1.1.2`.

### Fixed
- Stability fixes carried in feature cycles. See individual cycle entries
  for specifics (no standalone fix-only cycle in this band).

### Security
- CSRF strict-mode enforcement (cycle 51).
- CORS origin validation + deny logging (cycle 52).
- Webhook HMAC verifier with replay protection (cycle 55).
- JWT secret rotation with dual-key grace window (cycle 56).
- Audit log CSV export with row-level redaction (cycle 54).

### Removed
- None in cycles 51-60.

## [0.2.1 / backend 1.1.1] — Cycles 41-50 milestone — 2026-05-19

Half-century marker. Patch bumps only (root `0.2.0 → 0.2.1`, backend
`1.1.0 → 1.1.1`) — cycles 41-50 were polish, hardening, and consolidation
with no public API breaks. See `docs/cycles/CYCLE_50.md` for the milestone
narrative and `docs/MILESTONE.md` for cumulative cycle 1-40 metrics.

### Added
- **Cycle 50 — milestone consolidation**: `docs/cycles/CYCLE_50.md`
  half-century marker doc + CHANGELOG cycles 41-50 sweep + version bump
  to `0.2.1 / 1.1.1`.
- **Cycles 41-49** — polish + extension wave covering:
  - Realtime: `/ws/realtime` presence + typing + cursor.
  - Multi-tenant: org invites + per-org quota enforcement consolidation.
  - Mobile: Capacitor + PWA + push + deep-links end-to-end.
  - Privacy: PII masker + content scrub + `/api/legal/*` endpoints.
  - AI: anomaly detector + cost tracker + model router refinements.
  - Search: Postgres FTS across documents + chats + artifacts.
  - Observability: `/metrics` ruleset + OpenAPI 462-route snapshot +
    Postman collection.

### Changed
- Lint ratchet held at `--max-warnings 49` across cycles 41-50 (down from
  56 at start of the band).
- Root `package.json` version `0.2.0 → 0.2.1`.
- Backend `package.json` version `1.1.0 → 1.1.1`.

### Fixed
- Stability fixes carried in feature cycles (no standalone fix-only cycle
  in this band). See individual cycle entries below for specifics.

### Security
- Cumulative posture maintained: CSRF, session fingerprint binding,
  strict CSP, helmet, JWT `aud`/`iss`, granular audit log. No new audit
  issues introduced in cycles 41-50; baseline of 17 historical issues
  remains resolved.

### Removed
- None in cycles 41-50. (`xlsx` removal landed in cycle 37, see
  `[0.2.0]` section.)

## [0.2.0 / backend 1.1.0] — Cycles 31-40 milestone — 2026-05-19

Milestone consolidation release. Root package bumped `0.1.0 → 0.2.0`; backend
bumped `1.0.0 → 1.1.0`. Minor bumps only — no public API breaks.
See `docs/MILESTONE.md` for cumulative metrics across cycles 1-40.

### Added
- **Cycle 40 — milestone consolidation**: `docs/MILESTONE.md` cumulative metrics,
  comprehensive CHANGELOG sweep, CONTRIBUTING.md patterns section.
- **Cycle 39 — frontend perf**: dynamic editors split + chat-interface split +
  asset trim + Web Vitals reporting (`435f4e09`).
- **Cycle 38 — test curation**: 15 curated test files + perf budget gate,
  3 doc-intelligence failures fixed (`bbdb82f2`).
- **Cycle 36 — deploy hardening**: pre-check + post-check + blue-green scaffold +
  config validator + migration safety (`fdd7aec0`).
- **Cycle 35 — system cron + push routes**: `src/jobs/system-cron.js` wired
  (scrub-deleted-user-content @ 02:30 UTC, hard-delete-deleted-users @ 03:00 UTC);
  `/api/push` mounted (`40b310e3`).
- **Cycle 34 — integration suite**: consolidated user+org+webhook journey
  suite (`566742a3`).
- **Cycle 33 — ops**: alerting + shutdown registry + SLO tracker + telemetry
  error endpoint (`e7c5f8d1`).
- **Cycle 32 — cache layer**: write-behind + query dedup + AI response cache +
  SWR (`7749c240`).
- **Cycle 31 — privacy / GDPR**: PII masker + GDPR export redact + content scrub +
  legal endpoints (`2c3eaf26`).
- **Cycle 30 — AI failover**: failover policy + model router + token budget +
  SSE improvements (`62e69819`). NB: `resolveWithFallback` not yet wired into
  streaming inner loop — tracked separately.

### Changed
- **Cycle 35**: `/api/ai/generate` now invokes `enforceOrgQuotaSafe` (lazy require
  + try/catch wrapper) for org-scoped requests. Personal usage path unchanged.
- **Cycle 35**: Lint ratchet `--max-warnings 56 → 50` (-6). Captured
  `react-hooks/exhaustive-deps` ref in `components/elevenlabs-interface.tsx`.
- **Cycle 37 → 31-32**: Lint ratchet successive tightenings; lib/ `any` cleanup
  (`6d3116cf`).
- **Cycle 38**: TypeScript build perf — exclude generated artifacts; xlsx
  bibliography path replaced with exceljs.

### Fixed
- **Cycle 38**: 3 doc-intelligence test failures (parser timing + classifier
  edge cases).
- **Cycle 35**: `lastActiveAt` write path verified through write-behind cache in
  `middleware/auth.js`; query-dedup confirmed consumed on auth lookups.

### Security
- **Cycle 37 — xlsx removal**: `chore(deps): replace xlsx with exceljs (security)
  + safe minor bumps` (`74006d09`). Eliminates the unmaintained `xlsx`
  (CVE-affected: prototype pollution + ReDoS) from the dependency tree. Bibliography
  attachments now use `exceljs`.
- **Cycle 37 — audit fix**: `npm audit fix` non-breaking — 14 vulnerabilities
  resolved (`e19cbeda`).
- **Cycle 31 — PII / GDPR**: structured PII masker invoked on GDPR export,
  content scrub on hard delete, legal endpoints (`/api/legal/*`) for ToS / DPA /
  privacy.
- **Cycle 17 → 31 — security hardening cumulative**: CSRF, session fingerprint
  binding, strict CSP, granular audit log, helmet, JWT aud/iss validation.

### Deprecated / Removed
- **`xlsx` (SheetJS community build)** — removed in cycle 37. Replaced with
  `exceljs`. Any downstream code that still `require('xlsx')` will fail loudly
  — migrate to `lib/xlsx-compat` or use exceljs directly.

### Deferred
- `failover-policy.resolveWithFallback` (cycle 30) still not wired into the
  streaming inner loop in `/api/ai/generate` — needs SSE-state-sharing across
  providers and mid-stream restart. Tracked for a focused cycle.

## [Cycle 35] — 2026-05-19

### Added
- `src/jobs/system-cron.js` — internal cron registry wired into `backend/index.js`. Runs `scrub-deleted-user-content` daily at 02:30 UTC and `hard-delete-deleted-users` daily at 03:00 UTC (cycles 14 + 29 finally wired). Disabled in `NODE_ENV=test` and honoured by `SYSTEM_CRON_ENABLED=false`. Tests: `backend/tests/system-cron.test.js`.
- `/api/push` routes (cycle 22) now auto-mounted in `backend/index.js`.

### Changed
- `/api/ai/generate` now invokes `enforceOrgQuotaSafe` (lazy require + try/catch wrapper) so an org-scoped request gets quota-checked / increments the org counter / supports refund(). Personal usage path is unchanged (middleware is a no-op without org context).
- Lint ratchet `next lint --max-warnings 56 → 50` (-6). Fixed legitimate `react-hooks/exhaustive-deps` warning in `components/elevenlabs-interface.tsx` by capturing the audio ref at effect-setup time (React-recommended pattern).

### Deferred
- `failover-policy.resolveWithFallback` (cycle 28) is **not yet** wired into the streaming inner loop in `/api/ai/generate`. Doing so safely requires teaching the fallback flow how to share SSE state between providers and how to mid-stream restart a partial response — too high-risk to land in a cleanup cycle. Tracked for a focused cycle.

### Verified
- `lastActiveAt` field exists (`prisma/schema.prisma` line 58) and is written via the write-behind cache in `middleware/auth.js`.
- Query-dedup (`utils/query-dedup.js`) is consumed by `middleware/auth.js` on authenticated lookups.

## [Cycle 20] — 2026-05-19

### Added
- E2E happy-path smoke (`e2e/happy-path.spec.ts`) — register → chat → logout, fully `page.route('/api/**')`-mocked so it runs without a backend.
- Vitest snapshot tests for critical UI: `LongOperationIndicator` (5 s + 35 s elapsed states), `KeyboardShortcutsModal` (open + closed), `ErrorBoundary` (default fallback).
- Property-based tests with `fast-check` covering `utils/bigint-serializer.js` (round-trip + recursive walk), `services/rag/bm25.js` (non-negative scores, monotonicity in TF, single-doc match) and `utils/session-fingerprint.js` (determinism, discrimination, /24 collapse).

### Changed
- `playwright_smoke` CI step now runs with `--reporter=list` and uploads `playwright-report/` as an artifact on failure (7-day retention).

## [Cycle 19] — 2026-05-19

### Added
- Zod schemas + `validate` middleware + AI response contracts with codegen pipeline.

## [Cycle 18] — 2026-05-19

### Added
- Hybrid retrieval (vector + BM25) with MMR diversify, cost tracker, anomaly detector.

## [Cycle 17] — 2026-05-19

### Added
- CSRF protection, session fingerprint binding, strict CSP, and granular audit log entries.

## [Cycle 16] — 2026-05-19

### Added
- Developer-experience tooling: dev scripts, AsyncLocalStorage-backed structured logger, feature-flags scaffold.

## [Cycle 15] — 2026-05-19

### Added
- Operations test suites: chaos suite, SSE memory-leak test, autocannon load profile, nightly DB backup workflow.

## [Cycle 14] — 2026-05-19

### Added
- Data lifecycle: soft-delete framework, GDPR export/delete endpoints, audit log wiring across mutators.

## [Cycle 13] — 2026-05-19

### Changed
- CI: dependency caching, 4-shard backend tests, c8 coverage reports, secret-scan pre-commit hook.

## [Cycle 12] — 2026-05-19

### Added
- API documentation mirror (`openapi.json`), Swagger UI at `/api/docs`, contract tests.

## [Cycle 11] — 2026-05-19

### Added
- Infrastructure: i18n locale toggle, service-worker scaffold, analytics event taxonomy.

## [Unreleased] — Production Hardening Sprint (2026-05-04)

### 🧪 Frontend Testing (Vitest)
- **Vitest suite added**: 22 unit tests across 4 test files
  - `ErrorBoundary`: 8 tests — renders fallback, custom fallback, reset, analytics, no-message error, onError callback
  - `ProviderErrorBoundary`: 6 tests — renders fallback, reset, error message, console logging
  - `ApiClient`: 6 tests — 4xx rejection, 5xx retry, network retry, exhaustion, auth headers, 204 handling
  - `Token Refresh`: 2 tests — refresh on 401, single refresh for concurrent requests
- **Test infrastructure**: Vitest config with oxc disabled → esbuild for JSX, jsdom environment, path aliases
- **Scripts**: `test:unit`, `test:unit:watch`, `test:all` in package.json
- **Vitest config**: Fixed `oxc: { jsx: 'automatic' }` to handle JSX transformation without modifying the project tsconfig (which Next.js owns)
- **Total**: 30 unit tests across 5 test files — all passing

### 🔄 Token Refresh / Session Recovery
- **`tests/lib/refresh-token.test.ts`**: 2 tests covering 401 auto-refresh and concurrent request deduplication

### 📦 Request Queue
- **`lib/request-queue.ts`**: Request queue for offline resilience — queues fetch requests when backend is unreachable and replays them on reconnection
  - Promise-based `enqueue()` with immediate resolution when online
  - Queue and replay when offline
  - Failed items don't block subsequent replays
  - `cancelAll()` to abort queued operations
  - Browser online/offline event integration
  - Singleton pattern with subscriber notifications
- **`tests/lib/request-queue.test.ts`**: 8 tests covering queue behavior, replay order, failure handling, cancel, and no-double-replay

### 🔌 Connection Status Indicator
- **`components/connection-status.tsx`**: Floating badge showing backend connectivity
  - Real-time health checks via HEAD `/api/health` every 30s (5s when offline)
  - Three states: online (latency), offline (pulse + WifiOff), checking (spinner)
  - Auto-refresh with toggle, click to re-check
  - Listens to browser `online` event
  - Integrated into `app-wrapper.tsx` — visible on all pages

### 🔄 Token Refresh / Session Recovery
- **`lib/api.ts`**: Added automatic JWT refresh on 401 responses
  - Single in-flight refresh — concurrent 401s share one refresh call
  - Refreshed token retries the original request without consuming a retry slot
  - On refresh failure, token is cleared to force re-login
  - Private `_tryRefresh()` method with `_refreshing` promise guard

### 🏥 Health Dashboard
- **`app/admin/health/page.tsx`**: Full health monitoring UI at `/admin/health`
  - Summary cards: total services, healthy, degraded, critical counts
  - Individual check cards: database, Redis, queue, process, model providers, Sentry, Langfuse, PostHog
  - Color-coded status badges: healthy (green), degraded (yellow), unhealthy (red), skipped (gray)
  - Expandable JSON details per check
  - Auto-refresh every 30s with toggle
  - Error state with retry button
  - Spanish UI labels
- **`components/admin-sidebar.tsx`**: Added "Health" nav item with Heart icon

### 💾 Pending Messages — Resilient Sends
- **`lib/pending-messages.ts`**: Persists outgoing message payloads to localStorage before sending
  - `save(content, chatId, fileIds?, intent?)` — stores draft before the first attempt
  - `clear(chatId)` — removes on successful delivery
  - `getAll()` / `getForChat(chatId)` — load pending messages for retry
  - `retryAll(sendFn)` — replay all pending messages in order
  - `subscribeOnlineRetry(sendFn)` — auto-retry when browser comes online
  - Max 3 attempts per message, auto-cleanup after max
  - Degrades gracefully if localStorage is unavailable
- **`lib/chat-context-integrated.tsx`**: Integrated pending messages into `addMessage`
  - Saves message to localStorage BEFORE any API call (survives page crash)
  - Clears on successful delivery (sync intents + streaming completion)
  - Stays in storage on error — retried later on reconnect
  - `useEffect` in `ChatProvider` retries all pending on user login
- **`tests/lib/pending-messages.test.ts`**: 10 tests covering save, clear, retry, max attempts, partial failures, localStorage unavailability

### 📝 Documentation
- **`CONTRIBUTING.md`**: 3KB contribution guide — setup, structure, tests, conventions, Docker usage

### 🔐 Security
- **Startup validator**: Validates all critical env vars at boot — blocks startup on placeholder JWT/SESSION secrets, warns on low-entropy keys and unusual API key formats
- **express-async-errors**: Installed and wired in `index.js` — all async route rejections now properly forwarded to Express error handler instead of becoming unhandled rejections
- **Async handler utility**: `src/utils/async-handler.js` — wrapper for async routes that propagates errors to Express `next()`
- **Secrets generator**: `scripts/generate-secrets.sh` — generates cryptographically strong 64-char hex secrets for JWT, session, and encryption keys
- **`.env.example` overhaul**: Root + backend examples cleaned up, secrets marked with clear `⚠️ CHANGE THESE` warnings, docker-compose vars included
- **Environment reference**: Comprehensive `docs/operations/ENVIRONMENT.md` — documents every env var with descriptions, defaults, and notes

### 🐳 Docker & Deployment
- **Multi-stage Dockerfiles**: Both backend (`backend/Dockerfile`) and frontend (`Dockerfile`) rewritten to use multi-stage builds with non-root user and `HEALTHCHECK`
- **Production docker-compose**: `docker-compose.prod.yml` — standalone production config with resource limits, health checks, DB/Redis persistence, proper secrets handling
- **Dev docker-compose override**: `docker-compose.override.yml` — hot-reload with volume mounts, debug ports, dev images
- **Dev Dockerfiles**: `Dockerfile.dev` (frontend) + `backend/Dockerfile.dev` (backend) — lightweight images for development
- **PM2 ecosystem**: `backend/ecosystem.config.js` — process management with auto-restart, log rotation, memory limits, graceful shutdown
- **CI Docker build**: `.github/workflows/ci.yml` now builds both images with BuildKit caching in CI
- **Pre-deployment check**: `scripts/deploy-check.sh` — validates .env, secrets, Dockerfiles, error boundaries, gitignore before deploy

### 🛡️ Resilience & Error Recovery
- **Database connection retry**: `src/config/database.js` — exponential backoff on initial connect (configurable via `DB_CONNECT_RETRIES`, `DB_RETRY_BASE_DELAY_MS`)
- **Database operation retry**: `src/utils/db-retry-middleware.js` — wraps Prisma operations with transparent retry on transient errors (connection drops, pool timeout, DB restart)
- **Process event handlers**: `index.js` — `unhandledRejection` + `uncaughtException` handlers that log the error gracefully before exiting
- **Health check caching**: `/health` + `/health/ready` results cached for `HEALTH_CACHE_TTL_MS` (default 5s) to prevent DB hammering from monitoring systems
- **API client resilience**: `lib/api.ts` — transparent retry with exponential backoff, request timeout via AbortController, 4xx/5xx distinction
- **Auth/session login resilience**: Startup checks validate all auth env vars

### 🎨 Frontend Error Boundaries
- **`app/error.tsx`**: Route-level error boundary with recovery UI and error details
- **`app/global-error.tsx`**: Root-level error boundary (catches layout crashes)
- **`app/not-found.tsx`**: Custom 404 page
- **`app/loading.tsx`**: Suspense loading state
- **Provider error isolation**: `components/app-wrapper.tsx` now wraps each provider (`BackgroundStreams`, `ChatProvider`, `ArtifactPanel`) with individual `ErrorBoundary` guards — a crash in one doesn't cascade
- **Layout error boundary**: `app/layout.tsx` wraps the entire provider tree (Auth, Settings, AppWrapper) with a fallback UI and "Recargar página" / "Reintentar" buttons
- **ProviderErrorBoundary**: `components/provider-error-boundary.tsx` — dedicated class component for provider-level crash recovery

### 📋 Operations
- **Production checklist**: `docs/operations/PRODUCTION_CHECKLIST.md` — step-by-step deployment guide with pre-flight checks, monitoring setup, backup strategy
- **Architecture docs**: `docs/architecture/ARCHITECTURE.md` — system overview with component descriptions, data flow, decision records
- **Environment reference**: `docs/operations/ENVIRONMENT.md` — complete env vars reference (100+ variables documented)
- **DB backup script**: `scripts/backup-db.sh` — automated PostgreSQL backup with rotation, integrity checks, and latest symlink
- **Sentry source maps**: `scripts/upload-sentry-sourcemaps.sh` — upload source maps after production build for readable stack traces
- **Migration helper**: `backend/prisma/migrate.sh` (if used) — run Prisma migrations with health check

### ⚙️ Configuration
- **Next.js config**: `next.config.mjs` — `output: 'standalone'`, security headers (CSP, HSTS, X-Frame-Options, etc.), strict mode, output file tracing
- **Security headers**: Content-Security-Policy, Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- **Docker Compose**: All services now include healthchecks, resource limits, restart policies, and structured logging

### 📦 Dependencies
- Added `express-async-errors` (backend) — safe async error handling

### 🗺️ Files Created/Modified

```
# New files:
  Dockerfile                          # Multi-stage frontend build
  Dockerfile.dev                      # Frontend dev image
  docker-compose.override.yml         # Dev hot-reload overrides
  docker-compose.prod.yml             # Production compose
  app/error.tsx                       # Route-level error boundary
  app/global-error.tsx                # Root error boundary
  app/not-found.tsx                   # 404 page
  app/loading.tsx                     # Loading state
  backend/Dockerfile.dev              # Backend dev image
  backend/ecosystem.config.js         # PM2 process manager
  backend/src/utils/async-handler.js  # Async route wrapper
  backend/src/utils/db-retry-middleware.js  # DB retry middleware
  components/provider-error-boundary.tsx  # Provider crash isolation
  scripts/generate-secrets.sh         # Secret key generator
  scripts/backup-db.sh                # DB backup automation
  scripts/deploy-check.sh             # Pre-deployment validator
  scripts/upload-sentry-sourcemaps.sh # Sentry source maps upload
  docs/architecture/ARCHITECTURE.md   # System architecture
  docs/operations/PRODUCTION_CHECKLIST.md  # Deployment guide
  docs/operations/ENVIRONMENT.md      # Env vars reference
  CHANGELOG.md                        # This file

# Modified files:
  .env.example                        # Cleaned up, security warnings
  backend/.env.example                # Added HEALTH_CACHE_TTL_MS
  backend/index.js                    # express-async-errors, health cache, process handlers
  backend/src/config/database.js      # Retry logic on connect, pool config
  backend/src/utils/startup-validator.js  # DB retry config checks
  lib/api.ts                          # Retry + timeout + AbortController
  components/app-wrapper.tsx          # Provider error isolation
  app/layout.tsx                      # Error boundary around providers
  .github/workflows/ci.yml           # Docker build job
  next.config.mjs                     # Security headers, standalone output
```
