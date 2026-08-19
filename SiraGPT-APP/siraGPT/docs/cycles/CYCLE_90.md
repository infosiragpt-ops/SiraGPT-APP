# Cycle 90 — Ninth-Decade Milestone

**Date:** 2026-05-19
**Marker:** 90 continuous improvement cycles since 2026-05-18.
**Versions:** root `0.2.5`, backend `1.1.5`.

This document marks the cycles 81-90 consolidation. See the CHANGELOG
`[0.2.5 / backend 1.1.5]` section for the grouped entry and
`docs/cycles/CYCLE_80.md` for the previous milestone marker.

## Theme of the Band: Settings Hardening, Export Integrity, Cost + SSO Scaffold

Cycles 81-90 focused on configuration safety (zod settings),
export integrity + auth CSRF, GDPR export observability, locale + maintenance
metrics, member caching + usage trends, AI cost alerts + SSE telemetry,
SSO scaffolding (SAML/OIDC stubs), API key org-scoping with bearer
fallthrough, and per-scope authorization with API key counters.

## What Was Achieved

### Settings + activity (cycle 81)
- **Zod settings + member activity (81)** — strict zod schema validation
  for org settings JSON; per-member activity feed surfacing recent actions.

### Export integrity + auth CSRF (cycle 82)
- **Export integrity SHA-256 + CSRF in login/register (82)** — exports
  emit SHA-256 manifest for tamper detection; CSRF tokens enforced on
  login + register flows.

### GDPR observability + UI (cycle 83)
- **GDPR export metrics + SearchPanel retry (83)** — counters/histograms
  for GDPR export jobs; SearchPanel gains retry on transient failure.

### Maintenance + locale (cycle 84)
- **Maintenance metric + locale drift detector (84)** — maintenance-mode
  short-circuits emit metric; locale drift detector flags missing/extra
  keys across translation bundles.

### Members + analytics (cycle 85)
- **Members cache + usage-trend (85)** — short-TTL cache for member
  rosters; `usage-trend` endpoint exposes per-org trend deltas.

### AI cost + SSE (cycle 86)
- **AI cost alerts + SSE metrics (86)** — threshold-based AI cost alert
  notifier; SSE channel metrics (open/close/heartbeat) surfaced.

### SSO scaffold + cost edges (cycle 87)
- **SSO scaffold (SAML/OIDC 501) + cost-tracker edges (87)** — SAML and
  OIDC route stubs returning 501 Not Implemented; cost-tracker edge cases
  (negative duration, zero tokens, missing model) hardened.

### API keys org-scoped (cycle 88)
- **API keys org-scoped + bearer fallthrough (88)** — API keys carry
  `orgId` and scope authorization; bearer auth falls through to API key
  when JWT absent.

### Scope authorization (cycle 89)
- **requireScope + API key counter (89)** — `requireScope` middleware
  enforces per-route scope clearance; per-API-key invocation counter for
  rate + usage analytics.

### Marker (cycle 90)
- **This marker (90)** — milestone consolidation doc + CHANGELOG sweep
  + version bump to `0.2.5 / 1.1.5`.

## Test Stats
- Backend: ~1900+ tests (Node `--test`).
- Frontend: ~1180+ tests (Vitest / RTL).
- Lint ratchet: `--max-warnings 45` (held from cycle 60).

## Notable Files Touched
- `backend/src/services/org/settings.js` — zod schema (cycle 81).
- `backend/src/routes/org/members.js` — activity feed (81), cache (85).
- `backend/src/services/export/integrity.js` — SHA-256 manifest (82).
- `backend/src/middleware/csrf.js` — login/register enforcement (82).
- `backend/src/jobs/gdpr-export.js` — metrics (83).
- `components/SearchPanel.tsx` — retry UI (83).
- `backend/src/middleware/maintenance.js` — metric emit (84).
- `backend/src/services/i18n/locale-drift.js` — drift detector (84).
- `backend/src/routes/admin/usage-trend.js` — trend endpoint (85).
- `backend/src/services/billing/cost-alerts.js` — AI cost alerts (86).
- `backend/src/utils/sse-metrics.js` — SSE channel metrics (86).
- `backend/src/routes/auth/sso/saml.js` — SAML 501 stub (87).
- `backend/src/routes/auth/sso/oidc.js` — OIDC 501 stub (87).
- `backend/src/services/billing/cost-tracker.js` — edge cases (87).
- `backend/src/services/api-keys.js` — org-scoping (88).
- `backend/src/middleware/auth.js` — bearer fallthrough (88).
- `backend/src/middleware/require-scope.js` — scope guard (89).
- `backend/src/services/api-keys-counter.js` — invocation counter (89).

## What Comes Next (cycles 91+)
1. Promote SAML/OIDC stubs (87) to functional providers.
2. Wire `failover-policy.resolveWithFallback` into SSE inner loop
   (still carried from cycle 30).
3. Document pipeline: EPUB / RTF / ODT generators.
4. Redis-backed rate limiter promoted across all `/api/*` routes.
5. Per-org dashboard for RPS + cost + audit trend visualization.
