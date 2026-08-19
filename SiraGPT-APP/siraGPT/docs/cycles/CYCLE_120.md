# Cycle 120 — Second-Decade-Past-Centenarian Milestone

**Date:** 2026-05-19
**Marker:** 120 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.3.2`, backend `1.2.2` (PATCH bumps).

This document marks the cycles 111-120 consolidation — the second
decade past the centenarian. See the CHANGELOG `[0.3.2 / backend 1.2.2]`
section for the grouped entry and `docs/cycles/CYCLE_110.md` for the
previous milestone marker.

## Theme of the Band: Rate-Limit, Webhook & API-Key Hardening + Org Observability

Cycles 111-120 doubled down on the surface-area hardening story:
per-key rate limiting + audit sampling, webhook glob events + nonce
replay defence, payload-size guard + ApiKey soft-delete, trigger
unknown-event guard + endpoint usage analytics, forecast alerts +
webhook latency telemetry, revoke-all sessions + password audit,
webhook user cap + org stats, API keys pagination + search, webhook
pagination + toggle, and finally this marker consolidation.

## What Was Achieved

### Per-key rate limit + audit sampling (cycle 111)
- **per-key rate limit + audit sampling (111)** — per-API-key RPS
  budget on top of the existing per-IP limiter; configurable audit
  log sampling rate to reduce noise on hot paths while keeping
  forensic coverage.

### Webhook glob events + nonce replay (cycle 112)
- **webhook glob events + nonce replay (112)** — webhook subscriptions
  accept glob event patterns (e.g. `org.*`, `user.session.*`); inbound
  webhook receivers persist nonces and reject replays within the
  signature freshness window.

### Payload-size + ApiKey soft-delete (cycle 113)
- **payload-size + ApiKey soft-delete (113)** — explicit per-route
  payload size guard with friendly 413 responses; ApiKey deletion is
  now soft (tombstone + `deletedAt`) preserving audit linkage.

### Trigger unknown guard + endpoint usage (cycle 114)
- **trigger unknown guard + endpoint usage (114)** — webhook trigger
  emission validates the event against the registered catalogue and
  refuses unknown events; per-endpoint usage counters expose hot/cold
  routes for capacity planning.

### Forecast alerts + webhook latency (cycle 115)
- **forecast alerts + webhook latency (115)** — cost/usage forecaster
  emits alerts when projected month-end spend exceeds budget;
  webhook delivery latency is captured per attempt and surfaced in
  the health endpoint.

### Revoke-all sessions + password audit (cycle 116)
- **revoke-all sessions + password audit (116)** — single endpoint
  to revoke all of a user's active sessions (incident response);
  password change/reset events recorded in the audit trail with
  source IP and user-agent.

### Webhook user cap + org stats (cycle 117)
- **webhook user cap + org stats (117)** — per-user webhook quota
  enforced at create-time; new `/org/stats` endpoint summarises
  members, API keys, webhooks, sessions and recent activity.

### API keys pagination + search (cycle 118)
- **API keys pagination + search (118)** — cursor pagination + name
  search on the API keys listing; admin UIs can scale to large
  fleets without timing out.

### Webhook pagination + toggle (cycle 119)
- **webhook pagination + toggle (119)** — cursor pagination on the
  webhook listing; per-webhook enable/disable toggle without losing
  configuration or delivery history.

### This marker (cycle 120)
- **This marker (120)** — milestone consolidation doc + CHANGELOG
  sweep + **PATCH** version bump to `0.3.2 / 1.2.2`.

## Big-Picture Stats (cumulative)

| Metric | Value |
|---|---:|
| Improvement cycles completed | **~120** |
| Backend tests (Node `--test`) | **~1,800+** |
| Cron / scheduled jobs | **9+** |
| HTTP endpoints (public + admin) | **120+** |
| Multi-tenant (orgs + members + caps + CSV + stats) | production-ready |
| Auth (JWT + API keys w/ pagination/search/soft-delete + SSO scaffold + revoke-all + password audit) | production-ready |
| Webhooks (v2 signing + rotate + grace + nonce replay + glob events + pagination + toggle + latency + user-cap) | production-ready |
| Rate limiting (per-IP + per-key + payload-size + endpoint usage) | production-ready |
| Observability (metrics, traces, audit sampling, forecast alerts, webhook latency, org stats) | production-ready |
| Lint ratchet | `--max-warnings 45` (held since cycle 60) |

## Notable Files Touched

- `backend/src/middleware/rate-limit-per-key.js` — per-key RPS (111).
- `backend/src/services/audit/sampling.js` — sample-rate gating (111).
- `backend/src/services/webhooks/event-glob.js` — glob matcher (112).
- `backend/src/services/webhooks/nonce-store.js` — replay defence (112).
- `backend/src/middleware/payload-size.js` — 413 guard (113).
- `backend/src/services/apikey/soft-delete.js` — tombstone (113).
- `backend/src/services/webhooks/trigger-guard.js` — unknown-event reject (114).
- `backend/src/services/metrics/endpoint-usage.js` — per-route counters (114).
- `backend/src/services/billing/forecast-alerts.js` — projected-spend alerts (115).
- `backend/src/services/webhooks/latency.js` — per-attempt latency (115).
- `backend/src/routes/auth/revoke-all.js` — bulk session revoke (116).
- `backend/src/services/audit/password-events.js` — change/reset audit (116).
- `backend/src/services/webhooks/user-cap.js` — per-user quota (117).
- `backend/src/routes/org/stats.js` — `/org/stats` endpoint (117).
- `backend/src/routes/apikeys/list.js` — cursor pagination + search (118).
- `backend/src/routes/webhooks/list.js` — cursor pagination (119).
- `backend/src/routes/webhooks/toggle.js` — enable/disable (119).

## What Comes Next (cycles 121+)
1. Promote SSO SAML/OIDC stubs to functional providers.
2. Redis-backed rate limiter consolidating per-IP + per-key tiers.
3. Per-org dashboard for RPS + cost + audit trend visualization.
4. Document pipeline: EPUB / RTF / ODT generators.
5. Promote `/admin/system-report` into a public per-org analytics surface.
6. Webhook deliveries: dead-letter replay UI + bulk retry.
