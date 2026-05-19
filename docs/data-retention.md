# Data Retention Defaults

This document captures the default retention semantics for each
persisted model in siraGPT. Operators can override every default with
the documented environment variable, but the values below are what
ships in `main` and what privacy / GDPR responses should cite.

## Summary table

| Model      | Live retention            | Tombstone window         | Hard delete            | Override env                                |
|------------|---------------------------|--------------------------|------------------------|---------------------------------------------|
| `User`     | Indefinite (active)       | 30 days after `deletedAt`| Cron purges row + cascade | `SIRAGPT_USER_HARD_DELETE_DAYS`          |
| `AuditLog` | 1 year online             | Archived to cold storage | Never deleted          | `SIRAGPT_AUDIT_RETENTION_DAYS`              |
| `Session`  | Until `expiresAt`         | n/a (expired = removed)  | Sweep job              | `SIRAGPT_SESSION_TTL_DAYS`                  |
| `ApiUsage` | 90 days row-level         | Aggregated thereafter    | Detailed rows pruned   | `SIRAGPT_APIUSAGE_RAW_DAYS`                 |
| `File`     | Tied to owning user       | Inherits user tombstone  | Cascade on hard-delete | n/a (lifecycle bound to `User`)             |

## Per-model detail

### User
- Active users are kept indefinitely.
- A GDPR delete (`POST /api/users/me/delete`) sets `deletedAt` and
  cascades a soft-delete to every owned `Chat`, `Message`, `File`,
  `Project`, and `CustomGpt`.
- After **30 days** the `hard-delete-deleted-users` cron purges the row
  and every soft-deleted dependency. The 30-day window is the GDPR
  grace period — users can email `privacy@siragpt.io` to restore the
  account before purge.

### AuditLog
- All admin / security / GDPR events are written via
  `backend/src/utils/audit-log.js`.
- Online retention is **1 year**, after which rows are exported to the
  archive bucket and pruned from the operational database.
- The CSV export endpoint (`GET /api/admin/audit-logs.csv`) lets
  compliance offload events into a SIEM at any time.

### Session
- Sessions carry an explicit `expiresAt`. The default sliding TTL is
  the value of `SIRAGPT_SESSION_TTL_DAYS` (defaults to 30 days from
  issue).
- The session sweep job removes rows where `expiresAt <= now()`. There
  is no tombstone — expired sessions are deleted outright.
- Manual revocation (logout-all / soft-delete cascade) deletes the row
  immediately.

### ApiUsage
- Per-call rows are kept for **90 days** to support cost dashboards and
  abuse investigations.
- After 90 days the detailed rows are summarised into the daily /
  monthly aggregation tables and the source rows are dropped. The
  aggregates are kept indefinitely for billing reconciliation.

### Files
- File rows have no independent retention policy — they live and die
  with their owning user.
- A soft-deleted user's files inherit the same 30-day tombstone window
  as the user; when the hard-delete cron purges the user it also
  removes the file blobs from object storage.
- Files attached to a soft-deleted chat are scrubbed by the
  `scrub-deleted-user-content` job.

## Privacy notes

- Every retention boundary above is enforced by a scheduled job, never
  by a request-time check; an operator can audit purge runs from
  `/api/admin/health` and the job logs.
- The GDPR data export (`GET /api/users/me/export`) snapshots data
  *before* any retention boundary kicks in, so users always receive
  the same view their account holds at the moment they request the
  export.
