# Cycle 70 — Seventh-Decade Milestone

**Date:** 2026-05-19
**Marker:** 70 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.2.3`, backend `1.1.3`.

This document marks the cycles 61-70 consolidation. See the CHANGELOG
`[0.2.3 / backend 1.1.3]` section for the grouped entry and
`docs/cycles/CYCLE_60.md` for the previous milestone marker.

## Theme of the Band: Org-Scope, Lifecycle Hygiene + OTel Depth

Cycles 61-70 focused on tightening multi-tenant boundaries
(org-scoped webhooks, byOrg audit filters, per-org RPS), automating
lifecycle hygiene (90-day ApiUsage prune, hourly session sweep,
cron health probe), and pushing OpenTelemetry coverage deeper into
the HTTP and AI pipelines.

## What Was Achieved

### Lifecycle hygiene (cycles 61, 62, 64)
- **ApiUsage prune 90d job** (61) — scheduled cron deletes ApiUsage
  rows older than 90 days, configurable via `SIRAGPT_APIUSAGE_TTL_DAYS`,
  audit-logged per run with row counts.
- **Hourly session sweep** (62) — sweep job collapses idle sessions,
  evicts expired records from the session-manager in-memory store,
  and emits `session_sweep` audit events.
- **Cron health probe** (64) — `/api/admin/cron/health` exposes last-run
  timestamp + status per scheduled job; onboarding cache layer added to
  smooth first-load cold paths.

### Indexing + flags (cycle 63)
- **AuditLog actorId index + featureFlags** (63) — composite index on
  `(actorId, createdAt desc)` for fast per-user audit queries; feature
  flag service with per-org overrides and TTL cache.

### Multi-tenant boundaries (cycles 65, 66)
- **Org-scoped webhooks + cost groupBy=org** (65) — webhook signing
  keys and delivery policies bound to org; cost endpoint adds
  `groupBy=org` aggregation.
- **byOrg audit filter + session list/revoke** (66) — audit query API
  accepts `byOrg` filter with clearance check; admin endpoints to list
  active sessions per user and revoke individual session tokens.

### Streaming + safety (cycle 67)
- **SSE resume + prompt-injection detector** (67) — resumable SSE
  endpoints with `Last-Event-ID` replay window; lightweight
  prompt-injection heuristic detector wired into chat ingress with
  audit flagging.

### Observability depth (cycles 68, 69, 70)
- **OTel spans + per-org RPS** (68) — additional spans across AI
  request lifecycle; per-org requests-per-second gauge exported on
  `/metrics`.
- **HTTP span middleware + RPS wiring** (69) — central HTTP span
  middleware wraps every `/api/*` route with route template + status +
  duration attributes; RPS gauge wired from middleware.
- **This marker** (70) — milestone consolidation doc + CHANGELOG sweep
  + version bump to `0.2.3 / 1.1.3`.

## Test Stats
- Backend: ~1700+ tests (Node `--test`).
- Frontend: ~1100+ tests (Vitest / RTL).
- Lint ratchet: `--max-warnings 45` (held from cycle 60).

## Notable Files Touched
- `backend/src/jobs/apiusage-prune.js` — 90-day prune job (cycle 61).
- `backend/src/jobs/session-sweep.js` — hourly sweep (cycle 62).
- `backend/prisma/schema.prisma` — AuditLog actorId index (cycle 63).
- `backend/src/services/feature-flags.js` — per-org flag overrides (63).
- `backend/src/routes/admin/cron-health.js` — cron probe (cycle 64).
- `backend/src/services/webhooks/org-scope.js` — org-scoped delivery (65).
- `backend/src/routes/admin/cost.js` — `groupBy=org` (cycle 65).
- `backend/src/routes/admin/audit.js` — `byOrg` filter (cycle 66).
- `backend/src/routes/admin/sessions.js` — list / revoke (cycle 66).
- `backend/src/routes/ai-stream.js` — SSE resume (cycle 67).
- `backend/src/services/security/prompt-injection.js` — detector (67).
- `backend/src/middleware/otel-http.js` — HTTP span middleware (69).
- `backend/src/services/metrics/rps.js` — per-org RPS gauge (68, 69).

## What Comes Next (cycles 71+)
1. Wire `failover-policy.resolveWithFallback` into the SSE streaming
   inner loop (still carried from cycle 30).
2. Document pipeline: EPUB / RTF / ODT generators.
3. Redis-backed rate limiter promoted across all `/api/*` routes.
4. Frontend e2e coverage expansion for the new admin views.
5. Per-org dashboard for RPS + cost + audit trend visualization.
