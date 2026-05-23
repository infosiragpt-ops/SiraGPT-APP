# Cycle 110 — Decade-Beyond-Centenarian Milestone

**Date:** 2026-05-19
**Marker:** 110 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.3.1`, backend `1.2.1` (PATCH bumps).

This document marks the cycles 101-110 consolidation — the first
decade past the centenarian. See the CHANGELOG `[0.3.1 / backend 1.2.1]`
section for the grouped entry and `docs/cycles/CYCLE_100.md` for the
previous milestone marker.

## Theme of the Band: Org Tenancy + Communications + Lifecycle Polish

Cycles 101-110 deepened the multi-tenant + organizational lifecycle
story: API-key scope sweeps, OTel user attribution + hard budget
enforcement, webhook secret rotation/grace and v2 signing algorithm,
inactive-key sweeps, full org member email lifecycle (invite / join /
remove / transfer), preference + retry queue for notifications,
per-org plan caps with a `/limits` endpoint, and bulk invite + CSV
member export tooling.

## What Was Achieved

### ApiKey sweep + usedScopes (cycle 101)
- **ApiKey sweep + usedScopes (101)** — periodic sweep tracking the
  set of scopes actually exercised by each API key (`usedScopes`),
  surfacing over-permissioned keys.

### OTel user attrs + budget hard enforce (cycle 102)
- **OTel user attrs + budget hard enforce (102)** — user/org IDs
  propagated as OTel span attributes; budget thresholds now hard-stop
  AI calls instead of soft-warning.

### Webhook secret rotate + v2 algorithm (cycle 103)
- **webhook secret rotate + v2 algorithm (103)** — `POST` rotate
  endpoint plus a stronger v2 HMAC signing algorithm for outbound
  webhooks.

### Webhook secret grace + inactive API key sweeps (cycle 104)
- **webhook secret grace + inactive API key sweeps (104)** — rotated
  webhook secrets accept the previous secret during a grace window;
  inactive API keys auto-disabled after a configurable idle period.

### Org member email notifications (cycle 105)
- **org member email notifications (105)** — invites, accepts and
  role changes now trigger templated email notifications to the
  affected members + org admins.

### Removal + ownership transfer emails (cycle 106)
- **removal + ownership transfer emails (106)** — removal-from-org
  and ownership-transfer events generate dedicated email templates
  with auditable context.

### Email prefs + retry queue (cycle 107)
- **email prefs + retry queue (107)** — per-user notification
  preferences (categories opt-in/out) and a retry queue for transient
  SMTP failures with backoff + DLQ.

### Org member plan caps + /limits endpoint (cycle 108)
- **org member plan caps + /limits endpoint (108)** — per-plan member
  caps enforced at invite-time; new `/limits` endpoint exposes the
  current org's quotas and usage in a single call.

### Bulk invite + members CSV (cycle 109)
- **bulk invite + members CSV (109)** — bulk-invite endpoint accepts
  a list of emails with per-row validation + partial success; members
  list exportable as CSV for admin offboarding/audit.

### This marker (cycle 110)
- **This marker (110)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.3.1 / 1.2.1`.

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~110** |
| Backend tests (Node `--test`) | **~1,700+** |
| Cron / scheduled jobs | **8+** |
| HTTP endpoints (public + admin) | **110+** |
| Multi-tenant (orgs + memberships + invitations + caps + CSV) | production-ready |
| Auth (JWT + API keys w/ scope sweep + SSO scaffold + email verification) | production-ready |
| Communications (templated emails + prefs + retry queue + DLQ) | production-ready |
| Webhooks (v2 signing + rotate + grace + DLQ + health) | production-ready |
| Observability (metrics, traces w/ user attrs, audit, snapshot, summary, report) | production-ready |
| Lint ratchet | `--max-warnings 45` (held since cycle 60) |

## Notable Files Touched

- `backend/src/jobs/apikey-scope-sweep.js` — usedScopes tracking (101).
- `backend/src/utils/otel-attrs.js` — user/org attribute propagation (102).
- `backend/src/services/billing/budget-enforce.js` — hard stop (102).
- `backend/src/routes/webhooks/rotate.js` — rotate endpoint + v2 algo (103, 104).
- `backend/src/services/webhooks/signing-v2.js` — v2 HMAC (103).
- `backend/src/jobs/apikey-inactive-sweep.js` — auto-disable (104).
- `backend/src/services/email/org-templates.js` — invite/accept/role templates (105).
- `backend/src/services/email/lifecycle-templates.js` — removal + transfer (106).
- `backend/src/services/email/preferences.js` — opt-in/out matrix (107).
- `backend/src/services/email/retry-queue.js` — backoff + DLQ (107).
- `backend/src/services/plans/member-caps.js` — per-plan enforcement (108).
- `backend/src/routes/limits.js` — quota/usage endpoint (108).
- `backend/src/routes/org/bulk-invite.js` — bulk invite (109).
- `backend/src/routes/org/members-csv.js` — CSV export (109).

## What Comes Next (cycles 111+)
1. Promote SSO SAML/OIDC stubs to functional providers.
2. Wire `failover-policy.resolveWithFallback` into SSE inner loop.
3. Document pipeline: EPUB / RTF / ODT generators.
4. Redis-backed rate limiter promoted across all `/api/*` routes.
5. Per-org dashboard for RPS + cost + audit trend visualization.
6. Promote `/admin/system-report` into a public per-org analytics surface.
