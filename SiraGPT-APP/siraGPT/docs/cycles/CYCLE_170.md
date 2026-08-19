# Cycle 170 — Seventh-Decade-Past-Centenarian Milestone

**Date:** 2026-05-20
**Marker:** 170 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.4.2`, backend `1.3.2` (PATCH bumps — small
celebratory marker; cycles 161-170 expanded observability metrics,
cron admin surface, org-transfer governance, audit-log tag indexing
and CSV export, and org-scoped broadcast notifications).

This document marks the cycles 161-170 consolidation — seventy cycles
past the centenarian. See the CHANGELOG `[0.4.2 / backend 1.3.2]`
section for the grouped entry and `docs/cycles/CYCLE_160.md` for the
previous milestone marker.

## Theme of the Band: Observability + Audit Indexing + Org Governance

Cycles 161-170 pushed observability and governance forward: Prometheus
gauges and histograms for org membership and API-key activity, cron
job introspection helpers, org transfer approval policy with pending
state, audit-log CSV export and tag-based filtering, structured tag
writers for the most critical audit writers, and org-scoped broadcast
notifications.

## What Was Achieved

### Org members gauge metric (cycle 161)
- **Org members gauge metric (161)** — Prometheus gauge tracking
  active members per org with periodic refresh, exposed on
  `/metrics`.

### API key request histogram + active gauge (cycle 162)
- **API key request histogram + active gauge (162)** — per-key
  request latency histogram + active-keys gauge with labels for org,
  status, and route family.

### Cron nextRuns helper + admin extension (cycle 163)
- **Cron nextRuns helper + admin extension (163)** — `nextRuns()`
  helper computes the next N firings per job; admin cron-jobs page
  surfaces upcoming schedule for forecasting.

### Org transfer approval policy + OrgPendingTransfer (cycle 164)
- **Org transfer approval policy + OrgPendingTransfer (164)** — org
  ownership transfers require recipient approval; `OrgPendingTransfer`
  model holds pending state with TTL.

### Pending transfer sweep + list endpoint (cycle 165)
- **Pending transfer sweep + list endpoint (165)** — periodic sweep
  expires stale pending transfers; admin list endpoint surfaces all
  pending transfers with filter by org / recipient / state.

### Org audit-logs CSV export (cycle 166)
- **Org audit-logs CSV export (166)** — `GET /orgs/:id/audit-logs.csv`
  streams the org audit log as CSV with quota integration from
  cycle 158.

### Audit-query.byTags filter (cycle 167)
- **Audit-query.byTags filter (167)** — `auditQuery.byTags([...])`
  filters audit rows by tag intersection; backed by a tag index for
  fast lookup.

### writeAuditLog tags + 5 critical writers tagged (cycle 168)
- **writeAuditLog tags + 5 critical writers tagged (168)** —
  `writeAuditLog` accepts `tags: string[]`; 5 critical writers
  (auth, org-transfer, billing, api-key, webhook) emit structured
  tags for the new byTags filter.

### Org-scoped broadcast notifications (cycle 169)
- **Org-scoped broadcast notifications (169)** —
  `POST /orgs/:id/broadcast` fans out a notification to all org
  members with delivery tracking and per-member dismiss.

### This marker (cycle 170)
- **This marker (170)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.4.2 / 1.3.2` (small
  celebratory ten-cycle marker; no public API breaks).

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~170** |
| Backend tests (Node `--test`) | **~2,050+** |
| Cron / scheduled jobs | **17+** |
| HTTP endpoints (public + admin) | **180+** |
| Multi-tenant (orgs + members + caps + CSV + stats + announcements + require-2FA + idle detection + activity feed + broadcast) | production-ready |
| Auth (JWT + API keys + bulk-revoke + CSV + revoke-all + password audit + invite-verify + SMS-2FA + TOTP-2FA + recovery codes + WebAuthn + SAML + OIDC + SSOIdentity) | production-ready |
| Webhooks (per-org + DLQ + retry + bulk toggle/delete + maxRetries override + filters) | production-ready |
| Governance (provider preference + cost cap + per-org audit retention + export quota + 3y archive sweep + stale-settings sweep + org-transfer approval) | production-ready |
| Observability (org-members gauge + API-key histogram/gauge + cron nextRuns + audit tag index) | production-ready |
| Lint ratchet | `--max-warnings 44` (held from cycle 160) |

## Notable Files Touched

- `backend/src/metrics/org-members-gauge.js` — members gauge (161).
- `backend/src/metrics/api-key-metrics.js` — histogram + gauge (162).
- `backend/src/services/cron/next-runs.js` — nextRuns helper (163).
- `backend/src/routes/admin/cron-jobs.js` — nextRuns surface (163).
- `backend/prisma/schema.prisma` — `OrgPendingTransfer` model (164).
- `backend/src/services/orgs/transfer-policy.js` — approval policy (164).
- `backend/src/jobs/pending-transfer-sweep.js` — sweep (165).
- `backend/src/routes/admin/pending-transfers.js` — list endpoint (165).
- `backend/src/routes/orgs/audit-logs-csv.js` — CSV export (166).
- `backend/src/services/audit/audit-query.js` — byTags filter (167).
- `backend/src/services/audit/write-audit-log.js` — tags param (168).
- `backend/src/routes/orgs/broadcast.js` — org broadcast (169).

## What Comes Next (cycles 171+)

1. Per-org alerting hooks (Slack / email / webhook digest).
2. Audit-log tag taxonomy + admin tag manager.
3. Notification preferences per member (mute, digest, channels).
4. Cron job pause / resume admin controls.
5. Org transfer audit trail with rollback window.
6. Metric-driven autoscale signals for the webhook DLQ worker.
