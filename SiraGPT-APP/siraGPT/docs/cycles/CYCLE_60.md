# Cycle 60 — Sixth-Decade Milestone

**Date:** 2026-05-19
**Marker:** 60 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.2.2`, backend `1.1.2`.

This document marks the cycles 51-60 consolidation. See the CHANGELOG
`[0.2.2 / backend 1.1.2]` section for the grouped entry and
`docs/cycles/CYCLE_50.md` for the previous milestone marker.

## Theme of the Band: Security + Observability + Admin UX

Cycles 51-60 focused on closing the remaining security posture gaps
identified after the half-century review, exposing AI subsystem health
through Prometheus, and giving operators first-class admin tooling
(audit export, secret rotation, trend dashboards).

## What Was Achieved

### Security (cycles 51, 52, 55, 56)
- **CSRF strict** (51) — double-submit cookie upgraded to
  `SameSite=Strict`, per-session token rotation on login + privilege
  change, mandatory enforcement on every state-changing `/api/*` route.
- **CORS validation** (52) — strict origin allow-list with regex +
  wildcard subdomain support; explicit deny logging routed through the
  audit pipeline; preflight cache TTL tuned.
- **Webhook verifier** (55) — HMAC `X-Sira-Signature` header, ±5 min
  timestamp skew check, replay nonce cache, per-tenant signing keys
  surfaced through the admin UI.
- **Rotate-secret** (56) — `scripts/rotate-jwt-secret.js` CLI + admin
  endpoint `/api/admin/security/rotate-secret` with dual-key grace
  window (old + new accepted for 24h, then old retired).

### Observability (cycles 53, 57)
- **AI metrics Prometheus** (57) — `ai_tokens_total`,
  `ai_request_duration_seconds`, `ai_cost_usd_total`,
  `ai_failover_trips_total` exported on `/metrics`; rule pack updated
  in `docs/prometheus-rules.yml`.
- **MTD trend endpoints** (53) — `agentTaskTrend`, `signupTrend`,
  `uploadTrend` month-to-date aggregations powering the admin charts;
  cached at 5-minute TTL with stale-while-revalidate.

### Admin UX (cycles 54, 58, 59)
- **Audit CSV** (54) — `/api/admin/audit/export.csv` streaming exporter
  with column allow-list, row-level redaction for PII fields, and
  paginated cursor-based extraction.
- **Bookmark folders** (58) — nested folder model + drag-reorder API +
  per-folder ACLs (owner / shared / link); recursive move with cycle
  detection.
- **Search filters** (59) — advanced FTS filter params (date range,
  type, owner, tag) across documents + chats + artifacts; combinable
  with existing relevance ranking.

## Test Stats
- Backend: ~1559 tests (Node `--test`).
- Frontend: ~1060 tests (Vitest / RTL).
- Lint ratchet: `--max-warnings 45` (tightened from 49).

## Notable Files Touched
- `backend/src/middleware/csrf.js` — strict mode + rotation.
- `backend/src/middleware/cors.js` — allow-list validator + deny log.
- `backend/src/services/webhooks/verifier.js` — HMAC + replay cache.
- `backend/scripts/rotate-jwt-secret.js` — secret rotation CLI.
- `backend/src/routes/admin/security.js` — rotate-secret endpoint.
- `backend/src/routes/admin/metrics.js` — MTD trend endpoints.
- `backend/src/services/metrics/ai-metrics.js` — Prometheus exporters.
- `backend/src/routes/admin/audit-export.js` — streaming CSV.
- `backend/src/services/bookmarks/folders.js` — nested folder model.
- `backend/src/services/search/filters.js` — FTS filter builder.

## What Comes Next (cycles 61+)
1. Wire `failover-policy.resolveWithFallback` into the SSE streaming
   inner loop (carried from cycle 30).
2. Document pipeline: EPUB / RTF / ODT generators.
3. Service health probes — per-dependency health endpoint.
4. Redis-backed rate limiter promoted across all `/api/*` routes.
5. Frontend e2e coverage expansion for the new admin views.
