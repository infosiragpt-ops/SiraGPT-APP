# Cycle 180 — Eighth-Decade-Past-Centenarian Milestone

**Date:** 2026-05-20
**Marker:** 180 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.4.3`, backend `1.3.3` (PATCH bumps — small
celebratory marker; cycles 171-180 expanded admin audit search, prisma
schema validation, service-worker hardening, bundle analyzer, and a
broad rate-limit sweep across API keys, webhooks, Slack, invites, and
announcements).

This document marks the cycles 171-180 consolidation — eighty cycles
past the centenarian. See the CHANGELOG `[0.4.3 / backend 1.3.3]`
section for the grouped entry and `docs/cycles/CYCLE_170.md` for the
previous milestone marker.

## Theme of the Band: Audit Search + Rate-Limit Sweep + Frontend Hardening

Cycles 171-180 pushed admin-side audit search, schema validation,
service-worker hardening, bundle analyzer, and a broad rate-limit
sweep across mutating endpoints: org API keys, webhooks
create/delete, org Slack webhooks, org invite create/accept, and org
announcement create.

## What Was Achieved

### /admin/audit-logs/search endpoint (cycle 171)
- **/admin/audit-logs/search endpoint (171)** — global admin audit
  search across orgs with filter by actor, action, tag, time range,
  and free-text on payload.

### Per-org audit search (cycle 172)
- **Per-org audit search (172)** — `GET /orgs/:id/audit-logs/search`
  scoped to a single org with the same filter set, RBAC-gated to org
  owners and admins.

### Prisma format + schema-validate test (cycle 173)
- **Prisma format + schema-validate test (173)** — `prisma format`
  applied across `schema.prisma`; new test asserts the formatted file
  is canonical and a schema validity check runs in CI.

### SW hardening + bundle analyzer (cycle 174)
- **SW hardening + bundle analyzer (174)** — service worker cache
  versioning + safer fetch fallback; `@next/bundle-analyzer` wired
  behind an env flag for on-demand bundle introspection.

### Org API key rate limits (cycle 175)
- **Org API key rate limits (175)** — per-IP + per-user rate limits
  applied to API-key create/rotate/revoke endpoints with structured
  429 responses and audit emit.

### Webhook create+delete rate limits (cycle 176)
- **Webhook create+delete rate limits (176)** — rate limits on
  webhook create + delete to absorb misbehaving integrations or
  scripted abuse.

### Org Slack rate limits (cycle 177)
- **Org Slack rate limits (177)** — rate limits on org Slack webhook
  configure / test endpoints with audit emit on 429.

### Invite create+accept rate limits (cycle 178)
- **Invite create+accept rate limits (178)** — rate limits on invite
  create + accept to harden onboarding flow against enumeration and
  spam.

### Announcement create rate limit (cycle 179)
- **Announcement create rate limit (179)** — per-org rate limit on
  announcement create to prevent broadcast spam against members.

### This marker (cycle 180)
- **This marker (180)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.4.3 / 1.3.3` (small
  celebratory ten-cycle marker; no public API breaks).

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~180** |
| Backend tests (Node `--test`) | **~2,100+** |
| Cron / scheduled jobs | **17+** |
| HTTP endpoints (public + admin) | **190+** |
| Multi-tenant (orgs + members + caps + CSV + stats + announcements + require-2FA + idle detection + activity feed + broadcast + audit search + rate limits) | production-ready |
| Auth (JWT + API keys + bulk-revoke + CSV + revoke-all + password audit + invite-verify + SMS-2FA + TOTP-2FA + recovery codes + WebAuthn + SAML + OIDC + SSOIdentity + API-key rate limits) | production-ready |
| Webhooks (per-org + DLQ + retry + bulk toggle/delete + maxRetries override + filters + create/delete rate limits) | production-ready |
| Governance (provider preference + cost cap + per-org audit retention + export quota + 3y archive sweep + stale-settings sweep + org-transfer approval + audit search) | production-ready |
| Observability (org-members gauge + API-key histogram/gauge + cron nextRuns + audit tag index + audit search) | production-ready |
| Frontend hardening (SW cache versioning + bundle analyzer) | production-ready |
| Lint ratchet | `--max-warnings 44` (held from cycle 160) |

## Notable Files Touched

- `backend/src/routes/admin/audit-logs-search.js` — global search (171).
- `backend/src/routes/orgs/audit-logs-search.js` — per-org search (172).
- `backend/prisma/schema.prisma` — canonical format (173).
- `backend/tests/prisma-schema-validate.test.js` — schema validity (173).
- `public/sw.js` / `next.config.mjs` — SW hardening + bundle analyzer (174).
- `backend/src/routes/orgs/api-keys.js` — API-key rate limits (175).
- `backend/src/routes/orgs/webhooks.js` — webhook create/delete limits (176).
- `backend/src/routes/orgs/slack.js` — Slack rate limits (177).
- `backend/src/routes/orgs/invites.js` — invite create/accept limits (178).
- `backend/src/routes/orgs/announcements.js` — announcement create limit (179).

## What Comes Next (cycles 181+)

1. Audit-log search saved queries + scheduled exports.
2. Rate-limit dashboard with per-route observability.
3. Service-worker offline message queue for chat.
4. Bundle-size budget enforcement in CI.
5. Org-scoped IP allow-list for API keys.
6. Invite expiry policy + bulk revoke.
