# Cycle 130 — Third-Decade-Past-Centenarian Milestone

**Date:** 2026-05-19
**Marker:** 130 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.3.3`, backend `1.2.3` (PATCH bumps).

This document marks the cycles 121-130 consolidation — the third
decade past the centenarian. See the CHANGELOG `[0.3.3 / backend 1.2.3]`
section for the grouped entry and `docs/cycles/CYCLE_120.md` for the
previous milestone marker.

## Theme of the Band: Org Announcements + User Notifications + Critical-Channel Delivery

Cycles 121-130 turned org-internal broadcast and user-level inbox
plumbing into first-class subsystems: a pagination audit that
swept the session listing, the `OrgAnnouncement` model + endpoints,
announcement triggers wired into critical bulk email, accept-flow
verification fix + announcement sweep, announcement pagination + PUT
update, announcement reads + ack triggers, `/reads` + `/unread`
endpoints, a per-user notifications inbox, notification sweep + web
push for critical events, and finally this marker consolidation.

## What Was Achieved

### Pagination audit + sessions (cycle 121)
- **pagination audit + sessions (121)** — repo-wide listing audit
  for missing cursor pagination; sessions listing converted to cursor
  pagination so admin UIs never hit unbounded result sets.

### OrgAnnouncement model + endpoints (cycle 122)
- **OrgAnnouncement model + endpoints (122)** — new Prisma model
  for organisation-scoped announcements (title, body, severity,
  scheduledAt, expiresAt); CRUD endpoints under `/org/announcements`.

### Announcement trigger + critical bulk email (cycle 123)
- **announcement trigger + critical bulk email (123)** — announcement
  publish emits `org.announcement.published` webhook event;
  `critical` severity announcements fan out via bulk email to all
  org members (batched + rate-limited).

### Accept-needs-verif fix + announcement sweep (cycle 124)
- **accept-needs-verif fix + announcement sweep (124)** — fix for the
  invite-accept path so it requires email verification before
  granting membership; expired announcements swept by cron and
  archived without losing the audit trail.

### Announcement pagination + PUT (cycle 125)
- **announcement pagination + PUT (125)** — cursor pagination on the
  announcement listing; `PUT /org/announcements/:id` for full updates
  (versus the existing PATCH for partial fields).

### Announcement reads + ack trigger (cycle 126)
- **announcement reads + ack trigger (126)** — `OrgAnnouncementRead`
  junction table tracking per-user read receipts; `org.announcement.ack`
  webhook trigger emitted when a member marks an announcement as read.

### Announcement /reads + /unread (cycle 127)
- **announcement /reads + /unread (127)** — `GET /org/announcements/:id/reads`
  for per-announcement read receipts (admin view) and
  `GET /org/announcements/unread` for the current user's unread list.

### User notifications inbox (cycle 128)
- **user notifications inbox (128)** — per-user `Notification` model +
  inbox endpoints (`GET /me/notifications`, mark-read, mark-all-read);
  decoupled from announcement reads so direct/system notifications
  can land in the same surface.

### Notification sweep + webpush critical (cycle 129)
- **notification sweep + webpush critical (129)** — cron sweep
  archives notifications past their `expiresAt`; `critical`-severity
  notifications additionally trigger web push delivery to subscribed
  devices (best-effort, isolated from inbox write).

### This marker (cycle 130)
- **This marker (130)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.3.3 / 1.2.3`.

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~130** |
| Backend tests (Node `--test`) | **~1,900+** |
| Cron / scheduled jobs | **11+** |
| HTTP endpoints (public + admin) | **130+** |
| Multi-tenant (orgs + members + caps + CSV + stats + announcements) | production-ready |
| Auth (JWT + API keys w/ pagination/search/soft-delete + SSO scaffold + revoke-all + password audit + invite-verify) | production-ready |
| Webhooks (v2 signing + rotate + grace + nonce replay + glob events + pagination + toggle + latency + user-cap + announcement triggers) | production-ready |
| Announcements (CRUD + pagination + PUT + reads + unread + critical bulk email + sweep) | production-ready |
| User notifications (inbox + mark-read + sweep + webpush-critical) | production-ready |
| Rate limiting (per-IP + per-key + payload-size + endpoint usage) | production-ready |
| Observability (metrics, traces, audit sampling, forecast alerts, webhook latency, org stats) | production-ready |
| Lint ratchet | `--max-warnings 45` (held since cycle 60) |

## Notable Files Touched

- `backend/src/routes/auth/sessions-list.js` — cursor pagination (121).
- `backend/prisma/schema.prisma` — `OrgAnnouncement` + `OrgAnnouncementRead` + `Notification` (122, 126, 128).
- `backend/src/routes/org/announcements.js` — CRUD + pagination + PUT (122, 125).
- `backend/src/services/announcements/publish.js` — trigger emission (123, 126).
- `backend/src/services/email/bulk-critical.js` — batched critical fan-out (123).
- `backend/src/routes/org/invites/accept.js` — verify-required fix (124).
- `backend/src/jobs/announcement-sweep.js` — expiry archival cron (124).
- `backend/src/routes/org/announcements-reads.js` — `/reads` + `/unread` (127).
- `backend/src/routes/me/notifications.js` — inbox endpoints (128).
- `backend/src/jobs/notification-sweep.js` — expiry cron (129).
- `backend/src/services/webpush/critical.js` — critical-severity delivery (129).

## What Comes Next (cycles 131+)
1. Announcement targeting (member subsets, roles, tags).
2. Notification preferences per channel (email / web push / inbox).
3. Push-notification provider abstraction (APNs / FCM bridges).
4. Promote SSO SAML/OIDC stubs to functional providers.
5. Redis-backed rate limiter consolidating per-IP + per-key tiers.
6. Per-org dashboard for announcement reach + notification engagement.
