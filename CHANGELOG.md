# Changelog

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
