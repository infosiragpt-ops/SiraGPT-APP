# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and improvement cycles follow a sequential number with the date the work landed.

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
