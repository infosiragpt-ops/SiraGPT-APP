# 🔧 siraGPT — Environment Variables Reference

## Quick Start

```bash
# 1. Generate secure secrets
./scripts/generate-secrets.sh

# 2. Copy example and edit
cp .env.example .env
# Fill in your API keys, database URLs, etc.

# 3. Deploy with production topology
# Backend: PM2 on host. Frontend: Docker.
APP_DIR=/root/siraNew/siraGPT scripts/deploy-production.sh
```

---

## 🔐 Required Secrets

| Variable | Description | Default | Notes |
|----------|-------------|---------|-------|
| `JWT_SECRET` | JWT token signing key | — | Generate with `./scripts/generate-secrets.sh`. Min 32 chars. |
| `SESSION_SECRET` | Session cookie encryption | — | Generate separately from JWT_SECRET. Min 32 chars. |
| `PRISMA_DATABASE_URL` | Runtime database connection | — | Direct `postgresql://…`/`postgres://…` or remote `prisma+postgres://…`. |

## 🔌 LLM Providers (at least one required)

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (format: `sk-proj-...` or `sk-svc-...`) |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `GROQ_API_KEY` | Groq API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `XAI_API_KEY` | xAI API key for Grok voice STT/TTS and direct Grok voice replies |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GEMA4_MODEL_ID` | Free-tier fallback model id. Default: `Gema4-31B` |
| `GEMA4_PROVIDER` | Provider client for the free-tier fallback model. Default: `OpenAI` |
| `GEMA4_DISPLAY_NAME` | Display name returned in the model selector policy. Default: `Gema4 31B` |
| `GEMA4_ICON` | Icon key returned for the virtual fallback model. Default: `ChatGPTLogo` |

## 🗄️ Database & Cache

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `POSTGRES_HOST` | PostgreSQL host for POSTGRES-only resolver fallback | `db` in Compose |
| `POSTGRES_PORT` | PostgreSQL port for POSTGRES-only resolver fallback | `5432` |
| `POSTGRES_USER` | PostgreSQL user | `postgres` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `postgres` |
| `POSTGRES_DB` | PostgreSQL database name | `siragpt` |
| `PRISMA_DATABASE_URL` | Runtime Prisma datasource URL; may be direct PostgreSQL or remote Accelerate | — |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL URL for migrations, boot preflight, and advisory locking | — |
| `DATABASE_URL` | Legacy runtime fallback and direct-migration candidate | — |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Verify PostgreSQL TLS certificates. Only the explicit value `false` disables verification. | `true` |
| `DATABASE_SSL_CA` | Optional inline PEM CA certificate or path to a CA file. Overrides URL `sslrootcert`; never logged. | — |
| `DATABASE_SSL_CERT` | Optional inline PEM client certificate or path to a certificate file. Overrides URL `sslcert`; never logged. | — |
| `DATABASE_SSL_KEY` | Optional inline PEM client private key or path to a key file. Overrides URL `sslkey`; never logged. | — |
| `MIGRATION_COMMAND_TIMEOUT_MS` | Hard timeout for each asynchronous Prisma process tree | `300000` |
| `BOOT_COMMAND_TIMEOUT_MS` | Hard timeout for auxiliary boot commands such as stale-port cleanup | `5000` |
| `MIGRATION_DB_CONNECT_TIMEOUT_MS` | Boot-time `pg` connection deadline | `10000` |
| `MIGRATION_DB_QUERY_TIMEOUT_MS` | Boot-time `pg` client query deadline | `15000` |
| `MIGRATION_DB_STATEMENT_TIMEOUT_MS` | PostgreSQL server statement timeout requested by boot-time `pg` clients | `15000` |
| `MIGRATION_LOCK_TIMEOUT_MS` | Total advisory-lock acquisition deadline, including connect and lock queries | `120000` |
| `MIGRATION_ALLOW_EQUIVALENT_UNBASELINED` | Temporary no-schema U1 compatibility. A bounded zero diff may accept P3005 without changing migration history. | `0` |
| `SKIP_MIGRATIONS` | Skip migration execution for normal local boot only. Release `--migrate-only` rejects it. | `0` |
| `MIGRATION_NONFATAL` | Permit normal server boot to start degraded after a non-configuration migration failure. Never affects `--migrate-only`. | `0` |
| `DATABASE_POOL_MIN` | Informational lower pool bound used by instrumentation; clamped to `1..DATABASE_POOL_MAX` | `2` |
| `DATABASE_POOL_MAX` | Prisma v6 `connection_limit`; strictly parsed and clamped to `1..100` | `10` |
| `DATABASE_POOL_TIMEOUT_MS` | Pool acquisition timeout in milliseconds, clamped to `1000..300000` and rounded up to Prisma `pool_timeout` seconds | `10000` |
| `DATABASE_POOL_AUTOSCALE_ENABLED` | Start the advisory pool recommendation loop. It never replaces or resizes the live Prisma client. | `false` |
| `DATABASE_POOL_AUTOSCALE_INTERVAL_MS` | Advisory sampling interval in milliseconds, clamped to `1000..3600000` | `30000` |
| `DATABASE_POOL_AUTOSCALE_MIN` | Lowest limit the advisory policy may recommend, clamped to `1..100` | `2` |
| `DATABASE_POOL_AUTOSCALE_MAX` | Highest limit the advisory policy may recommend, clamped to `1..100` and never below min | `50` |
| `DATABASE_POOL_AUTOSCALE_COLD_SAMPLES` | Consecutive cold samples required before a scale-down recommendation, strictly parsed and clamped to `1..20` | `3` |

Runtime resolution prefers `PRISMA_DATABASE_URL`, then `DATABASE_URL`. Migration
resolution prefers `DIRECT_DATABASE_URL`, then a direct `DATABASE_URL`, then a
direct `PRISMA_DATABASE_URL`. An Accelerate runtime may therefore coexist with
a different direct migration URL. Divergent aliases that compete for the same
role fail closed with role-specific codes and no values in logs.

Standard and production Compose pass the URL roles through unchanged. Only
when all three are empty does the shared pure resolver synthesize a local
runtime/direct URL from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`. Any explicit runtime URL suppresses
that fallback, preventing a remote runtime from silently migrating the local
Compose database.

Migration startup never copies a remote runtime URL into `DATABASE_URL`. When
the runtime is remote and no direct candidate exists, startup exits non-zero
with `DIRECT_DATABASE_URL_REQUIRED`. Each Prisma child command and every
boot-time `pg` connect/query/statement is bounded by the timeout controls above;
the advisory-lock deadline includes both connection and query time.

TLS-enabled boot-time PostgreSQL clients verify the server certificate by
default. The wrapper parses the direct URL, rejects insecure or conflicting
SSL modes unless verification is explicitly disabled, removes URL-level SSL
parameters only after constructing `pg`'s authoritative `ssl` object, and maps
`sslrootcert`, `sslcert`, and `sslkey` to `ca`, `cert`, and `key`. Set
`DATABASE_SSL_REJECT_UNAUTHORIZED=false` only as an explicit temporary
compatibility exception. `DATABASE_SSL_CA`, `DATABASE_SSL_CERT`, and
`DATABASE_SSL_KEY` override their corresponding URL values and accept either
inline PEM or a regular PEM file of at most 1 MiB. Client certificate and key
must be configured together. Unreadable, oversized, malformed, duplicate, or
incomplete URL material fails startup with a stable value-free configuration
code; certificate contents and paths are never emitted in logs.

`--migrate-only` is fail-closed: exhausted preflight retries, advisory-lock
errors, migration errors, command timeouts, and lock-release errors return
non-zero. It also rejects `SKIP_MIGRATIONS=1` with configuration exit 78.
Normal local server boot may skip migrations or use the documented
`MIGRATION_NONFATAL=1` degraded policy, but neither weakens release migrations.

P3005 never invokes `prisma migrate resolve` in either path. For this no-schema
U1 rollout only, `MIGRATION_ALLOW_EQUIVALENT_UNBASELINED=1` runs a bounded
`prisma migrate diff --exit-code` from the direct datasource to
`schema.prisma`. A zero diff returns the distinct logged
`schema_equivalent_unbaselined` success without retrying migration or modifying
history; any drift or diff error fails. U0 must perform a reviewed one-off
migration-history baseline before schema-bearing units. Do not use the U1
compatibility mode as a substitute for that reviewed release operation.

For direct `postgres:` and `postgresql:` runtime URLs, the runtime builder
preserves unrelated parameters such as `schema`, `sslmode`, and `pgbouncer`,
while replacing only `connection_limit` and `pool_timeout`. It never rewrites
`prisma+postgres:` remote/Accelerate URLs, whose local pool capacity is
reported as unobservable.

For observable direct connections, full `GET /health` reports estimated
active/idle connections and estimated saturation plus any advisory
recommendation. Label-free bounded gauges are exported from `GET /metrics`.
Remote capacity omits those local estimates and recommendations. Datasource
URLs and credentials are never included in pool logs.

## 🛑 Runtime Lifecycle

| Variable | Description | Default |
|----------|-------------|---------|
| `SIRAGPT_PARENT_SHUTDOWN_TIMEOUT_MS` | Maximum time the single-container `start-all` parent waits for backend/frontend exit events after forwarding `SIGTERM` or `SIGINT`; clamped to 40000–120000 ms. On Windows the backend chain uses IPC, and `taskkill /T /F` is reserved for this deadline. | `50000` |
| `SIRAGPT_WORKSPACE_RUN_STOP_GRACE_MS` | Per-workspace dev-runner grace before escalating from graceful termination to a forced process-tree kill. | `3000` |

The backend races every shutdown hook against the remaining portion of its
30-second global deadline. PM2 and both backend Compose services allow 35
seconds before force-kill, which exceeds that backend budget while remaining
below the parent coordinator's 40-second minimum and 50-second default.

## 🔒 Security

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime mode; production requires the literal `production` value and the `prod` alias is rejected | `development` |
| `CORS_ORIGINS` | Comma-separated exact allowed origins; required and validated in production | `http://localhost:3000` locally; production Compose uses the `.com` Caddy hosts |
| `CSP_ENABLED` | Enable Content Security Policy | `true` |
| `CSP_REPORT_ONLY` | Report-only mode (vs enforcement) | `true` |
| `CSP_REPORT_URI` | CSP violation report endpoint | (empty) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms | `900000` (15 min) |
| `RATE_LIMIT_AUTH_MAX` | Max auth requests per window | `30` |
| `RATE_LIMIT_EXPENSIVE_MAX` | Max expensive requests per window | `180` |
| `RATE_LIMIT_API_MAX` | Max API requests per window | `3000` |
| `RATE_LIMIT_STORE` | Rate limit store backend | `auto` (Redis or memory) |
| `RATE_LIMIT_SENSITIVE_POLICY` | Sensitive auth/API-key/billing policy; production permits only `distributed` | `distributed` in production |
| `RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS` | ioredis command timeout and matching outer deadline for every rate-limit command/pipeline | `1000` |
| `RATE_LIMIT_STORE_RETRY_AFTER_SECONDS` | Retry delay returned when a required distributed store is unavailable | `5` |
| `RATE_LIMIT_BILLING_CHECKOUT_MAX` | Checkout attempts per user | `10` |
| `RATE_LIMIT_BILLING_CHECKOUT_IP_MAX` | Checkout attempts per normalized shared IP | `100` |
| `RATE_LIMIT_BILLING_VERIFY_MAX` | Checkout verification attempts per user | `20` |
| `RATE_LIMIT_BILLING_VERIFY_IP_MAX` | Checkout verification attempts per normalized shared IP | `200` |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_MAX` | Plan/subscription mutations per user | `5` |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_IP_MAX` | Plan/subscription mutations per normalized shared IP | `50` |
| `RATE_LIMIT_BILLING_WINDOW_MS` | Checkout and verification window | `900000` |
| `RATE_LIMIT_BILLING_PLAN_WINDOW_MS` | Plan/subscription mutation window | `3600000` |
| `RATE_LIMIT_BILLING_REFUND_MAX` | Admin grants/refunds per admin | `5` |
| `RATE_LIMIT_BILLING_REFUND_IP_MAX` | Admin grants/refunds per normalized shared IP | `50` |
| `RATE_LIMIT_BILLING_REFUND_WINDOW_MS` | Admin refund window | `3600000` |
| `SIRAGPT_API_KEY_AUDIT_COUNTER_MAX` | Maximum in-process API-key audit-sampling counters | `10000` |
| `CSRF_DISABLED` | Emergency/test-only CSRF bypass; never enable in production | `0` |
| `CSRF_PEPPER` | CSRF HMAC pepper; derives from `JWT_SECRET` when omitted | (derived) |
| `FRONTEND_URL` | Canonical browser origin for the token-free SAML `303` completion redirect | `http://localhost:3000` outside production |
| `TRUST_PROXY_HOPS` | Bounded number of known reverse-proxy hops; production Compose pins one Caddy hop | `0` for direct binds |
| `TRUST_PROXY_CIDR` | Alternative comma-separated exact trusted proxy CIDRs; clear `TRUST_PROXY_HOPS` before using | (empty) |
| `SESSION_TOKEN_HASH_MODE` | Rolling-safe session persistence: `compat` reads raw/hash, writes raw, and never upgrades; `hash` writes hashes and upgrades legacy rows | `compat` in production/staging; `hash` elsewhere |
| `SESSION_TOKEN_HASH_COMPAT_DRAINED` | Explicit acknowledgement required before production starts in `hash` mode | `0` |
| `SESSION_TOKEN_HASH_BACKFILL_BATCH_SIZE` | Maximum raw rows converted inside one activation transaction (1–1000) | `100` |
| `SESSION_TOKEN_HASH_BACKFILL_MAX_BATCHES` | Maximum transactions per readiness pass; subsequent probes resume incomplete backfills (1–100) | `10` |
| `AUTH_SECURITY_REDIS_MAX_MEMORY_RATIO` | Readiness ceiling for used/max Redis memory after Lua and `noeviction` checks | `0.8` |
| `AUTH_SECURITY_READY_RETRY_BASE_MS` | Initial delay before retrying failed auth-security readiness (10–60000 ms) | `250` |
| `AUTH_SECURITY_READY_RETRY_MAX_MS` | Maximum exponential auth-security readiness delay (10–60000 ms) | `5000` |
| `OAUTH_STATE_TTL` | Signed OAuth state and matching one-time-store lifetime, clamped to 1–15 minutes | `10m` |
| `OAUTH_STATE_RETRY_AFTER_SECONDS` | Bounded `Retry-After` for a required OAuth state-store outage | `5` |
| `OAUTH_STATE_CACHE_MAX_ENTRIES` | Maximum live OAuth states in Redis or bounded non-production memory | `10000` |
| `OAUTH_STATE_REDIS_CONNECT_TIMEOUT_MS` | OAuth-state Redis connection deadline; clamped to 10–2000 ms | `500` |
| `OAUTH_STATE_REDIS_COMMAND_TIMEOUT_MS` | OAuth-state ioredis and wrapper command deadline; clamped to 10–2000 ms | `500` |
| `OAUTH_STATE_REDIS_PREFIX` | Namespace for SHA-256-keyed OAuth state JTIs | `sira:oauth-state:` |
| `IMPERSONATION_TARGET_LIMIT` | Attempts per admin+target sliding window | `3` |
| `IMPERSONATION_ADMIN_LIMIT` | Attempts per global-admin sliding window | `10` |
| `IMPERSONATION_WINDOW_MS` | Impersonation sliding window; clamped to 1 second–24 hours | `3600000` |
| `IMPERSONATION_MEMORY_MAX_KEYS` | Maximum local limiter keys outside production | `10000` |
| `IMPERSONATION_REDIS_CONNECT_TIMEOUT_MS` | Impersonation Redis connection deadline; clamped to 10–2000 ms | `500` |
| `IMPERSONATION_REDIS_COMMAND_TIMEOUT_MS` | Impersonation atomic-command deadline; clamped to 10–2000 ms | `500` |
| `IMPERSONATION_REDIS_PREFIX` | Namespace for hashed impersonation buckets | `sira:impersonation:` |
| `IMPERSONATION_STORE_RETRY_AFTER_SECONDS` | Bounded `Retry-After` when the required store is unavailable | `5` |
| `SAML_REQUEST_TTL_MS` | Lifetime for SP-initiated AuthnRequest IDs and RelayState; clamped to 1–15 minutes | `300000` |
| `SAML_REQUEST_CACHE_MAX_ENTRIES` | Maximum live request/state entries in the bounded SAML cache | `5000` |
| `SAML_REDIS_CONNECT_TIMEOUT_MS` | Redis connection deadline for SAML request state; clamped to 10–2000 ms | `500` |
| `SAML_REDIS_COMMAND_TIMEOUT_MS` | ioredis and wrapper deadline for every SAML cache command; clamped to 10–2000 ms | `500` |
| `SAML_REDIS_RETRY_BASE_MS` | Initial Redis initialization retry delay for SAML state; clamped to 10–5000 ms | `100` |
| `SAML_REDIS_RETRY_MAX_MS` | Maximum SAML Redis exponential-backoff delay; clamped to 10–60000 ms | `5000` |
| `SAML_REDIS_PREFIX` | Dedicated Redis namespace for SAML request and RelayState keys | `sira:saml:` |
| `SAML_RELAY_STATE_SECRET` | HMAC secret for RelayState; derives from `JWT_SECRET` when omitted | (derived) |
| `SAML_ACS_BODY_LIMIT_BYTES` | Exact SAML ACS URL-encoded body cap; clamped to 64–512 KiB | `262144` |
| `SAML_ACS_RATE_LIMIT_MAX` | Exact ACS POST attempts per normalized IP and window | `30` |
| `SAML_ACS_RATE_LIMIT_WINDOW_MS` | Exact ACS distributed limiter window; clamped to 1 second–15 minutes | `60000` |
| `SIRAGPT_REDACT_EXTRA_HEADERS` | Optional comma-separated header names to redact from logs/traces in addition to the built-in deny list | (empty) |
| `SIRAGPT_REDACT_EXTRA_QUERY_KEYS` | Optional comma-separated query parameter names to redact from logs/traces in addition to the built-in deny list | (empty) |
| `PLAN_QUOTAS_ENFORCED` | Enforce plan-based token quotas | `true` |

Production startup blocks missing Redis, process-memory sensitive limiting,
and sensitive `memory`/`fail-open` policies. Auth, API-key, and billing
limiters return a no-store 503 with `Retry-After` if Redis is unavailable. The
general API catch-all remains available (fail-open) during that incident.
Billing consumes the tight per-user and higher shared-IP dimensions atomically.
IPv6 addresses use `/64` buckets and IPv4 is canonicalized from Express
`req.ip`/the direct socket; raw `X-Forwarded-For` is never parsed by a limiter.

CSRF protection applies automatically to state-changing `/api/*` requests
that carry the login cookie. Safe methods and Bearer/API-key requests bypass
the guard. Stripe's signed webhook is exempt only at its exact path. SAML
HTTP-POST assertions bypass Sira CSRF only on the exact
`/api/auth/sso/:orgSlug/callback` path with a standard `SAMLResponse` field;
signature and InResponseTo/replay validation still execute. Public
generated-app mounts `/api/apps-ai` and `/api/apps-kv` remain exempt.
Production startup rejects missing, malformed, or wildcard `CORS_ORIGINS` and
enabled `CSRF_DISABLED`. Cookie-auth unsafe requests also require a trusted
Origin and `Sec-Fetch-Site` of `same-origin` or `same-site`.

SP-initiated SAML begins at `GET /api/auth/sso/:orgSlug/login`.
`@node-saml/node-saml` generates the AuthnRequest and authorize redirect with
`validateInResponseTo: 'always'`. Signed, one-time RelayState binds the
organization to that request ID; the ACS atomically consumes both and checks
exact Destination plus configured Audience. In production, Redis is mandatory
and any connection or command outage fails closed with a bounded no-store 503;
the bounded memory fallback is non-production only. Redis initialization uses
a bounded exponential-backoff circuit: every production attempt fails closed,
then a later request retries and can recover without restarting the backend.

The initiating browser receives a high-entropy pre-auth nonce cookie. It is
`HttpOnly`, scoped only to that organization's callback path, and
`SameSite=None` (`Secure` in production) so the cross-site SAML form POST can
return it. Only its SHA-256 hash is stored. The ACS compares and consumes that
hash atomically and clears the cookie; cross-browser/login-CSRF attempts fail
without consuming the legitimate browser's state.

A successful form ACS sets the standard session cookie, issues the existing
CSRF cookie pair, and returns a `303` to the `/auth/callback` path on the
validated same origin as `FRONTEND_URL`, without a JWT in the URL or body.
Explicit JSON negotiation requires both `Accept: application/json` and
`X-Sira-Response-Mode: json`, and still omits the JWT. IdP CORS is not required:
the exact standard form POST to the ACS emits no credentialed CORS headers.
OIDC GET callbacks and all other auth routes retain the normal CORS behavior.
The dedicated fail-closed ACS rate limiter executes before the bounded body
parser and request telemetry. It returns `429` on exhaustion, `503` when the
required production Redis store is unavailable, and the parser returns `413`
above the clamped body limit.

Use `NODE_ENV=production` literally for production. The `prod` alias is a
blocking, value-free startup error so no subsystem applies only part of the
production security policy.

Use only one proxy topology setting. Direct deployments keep
`TRUST_PROXY_HOPS=0`; the production Caddy topology uses exactly one hop.
Prefer `TRUST_PROXY_CIDR` when the proxy network is stable and known.

### Authentication revocation and deletion races

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_USER_LOCK_TIMEOUT_MS` | Maximum PostgreSQL wait for the per-user transactional auth lock shared by session/challenge issuance and deletion; clamped to 25–5000 ms. | `500` |
| `AUTH_REVOCATION_REDIS_CONNECT_TIMEOUT_MS` | Connect/subscribe deadline for the non-offline Redis revocation bridge; clamped to 10–2000 ms. | `500` |
| `AUTH_REVOCATION_REDIS_COMMAND_TIMEOUT_MS` | Publish deadline for distributed user/session revocation; clamped to 10–2000 ms. | `500` |
| `AUTH_SOCKET_REVALIDATION_CACHE_TTL_MS` | Positive-result cache TTL for long-lived socket session checks; clamped to 100–30000 ms. | `5000` |
| `AUTH_SOCKET_REVALIDATION_TIMEOUT_MS` | Database deadline for each socket session revalidation; clamped to 10–10000 ms. | `2000` |
| `AUTH_SOCKET_REVALIDATION_CACHE_MAX` | Maximum positive socket-validation cache entries; clamped to 10–20000. | `2000` |

The revocation bridge subscribes before the HTTP listener binds and uses Redis
only to shorten revocation latency across replicas. It disables offline
command queues and degrades to local events plus periodic persisted-session
validation when Redis is absent or unavailable. Realtime and computer-use
sockets revalidate immediately after indexing and on their heartbeat, so a
handshake race or missed pub/sub message cannot preserve access indefinitely.

## 📊 Observability

| Variable | Description | Default |
|----------|-------------|---------|
| `SENTRY_DSN` | Sentry DSN for error tracking | (disabled) |
| `SENTRY_ENABLED` | Enable Sentry | `false` |
| `SENTRY_TRACES_SAMPLE_RATE` | Traces sample rate (0-1) | `0` |
| `SENTRY_PROFILES_SAMPLE_RATE` | Profile sample rate (0-1) | `0` |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint | (empty) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | (disabled) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key | (disabled) |
| `POSTHOG_API_KEY` | PostHog API key | (disabled) |
| `POSTHOG_HOST` | PostHog host URL | (PostHog Cloud US) |
| `HEALTH_CACHE_TTL_MS` | Health check cache TTL in ms | `5000` |
| `HEALTH_DB_TIMEOUT_MS` | Timeout for public database and migration health queries, clamped to 100–10000 ms | `1500` |
| `HEALTH_REDIS_TIMEOUT_MS` | Timeout for the public Redis health ping and its dedicated client command, clamped to 100–10000 ms | `1000` |
| `INTERNAL_HEALTH_TOKEN` | Dedicated bearer credential for remote `/internal/health/*` access. When unset, `METRICS_TOKEN` is the machine-token fallback. | — |
| `INTERNAL_HEALTH_ALLOW_LOOPBACK` | Permit direct socket-loopback access to internal health in production. Ignored whenever `Forwarded` or `X-Forwarded-*` is present. | `false` |
| `HEALTH_PROBE_INTERVAL_MS` | Internal health-history scheduler interval in ms, clamped to Node's safe timer range 1000–2147483647 | `30000` |
| `HEALTH_PROVIDER_PROBES_ENABLED` | Register configured `provider-*` probes. Disabled by default to avoid exposing paid/rate-limited checks. | `false` |
| `HEALTH_SCHEDULE_PROVIDER_PROBES` | Periodically poll registered `provider-*` probes. Effective only when `HEALTH_PROVIDER_PROBES_ENABLED=true`. | `false` |
| `HEALTH_QUEUE_PROBE_TIMEOUT_MS` | Timeout for each dedicated BullMQ health operation, clamped to 100–10000 ms | `1500` |
| `HEALTH_QUEUE_PROBE_CACHE_TTL_MS` | Dedicated queue-health result cache TTL, clamped to 0–5000 ms | `1000` |
| `HEALTH_CRITICAL_QUEUES` | Comma-separated queue IDs/names whose probe failure makes readiness unhealthy. Known IDs: `agent-task`, `chat-run`, `codex-runs`, `document-collections`, `goal-runs`. | Production Compose: all five; standard Compose: none |

The Redis readiness ping is bounded independently of the driver. A timeout
returns the stable `REDIS_PROBE_TIMEOUT` code as a critical unhealthy check;
late driver rejection is absorbed after the response has completed.

Production Compose defaults all five registered queues to critical, so failure
of any physical queue makes readiness return HTTP 503. A missing `REDIS_URL`
also returns 503 whenever at least one physical queue is selected as critical.
Standard Compose keeps the default empty
for local development, and both files allow an explicit `HEALTH_CRITICAL_QUEUES`
override.

`GET /internal/health/live`, `/ready`, and `/history` return
`Cache-Control: no-store`. In production, access requires an exact constant-time
bearer match against `INTERNAL_HEALTH_TOKEN` (`METRICS_TOKEN` is used only when
the dedicated token is unset) or a session-backed super-admin JWT. Direct
socket-loopback bypass is enabled by default only outside production; production
requires `INTERNAL_HEALTH_ALLOW_LOOPBACK=true`. Any `Forwarded` or
`X-Forwarded-*` header disables loopback bypass in every environment, so a
same-host reverse proxy cannot inherit localhost trust. API keys are denied even
for super-admin owners.

## 💳 Payments

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret or restricted key (`sk_live_...`, `rk_live_...`, or test equivalent) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_WEBHOOK_RETRIEVE_SUBSCRIPTION_STATE` | Opt-in (`true`/`1`/`on`) remote subscription snapshot retrieval during invoice-success handling; disabled by default so webhook decisions remain local and deterministic |
| `STRIPE_WEBHOOK_RECOVERY_DISABLED` | Emergency switch that disables the autonomous durable webhook recovery loop (`true`/`1` disables it) |
| `STRIPE_WEBHOOK_RECOVERY_INTERVAL_MS` | Interval between bounded recovery scans; clamped to 1 second–1 hour (default `60000`) |
| `STRIPE_WEBHOOK_RECOVERY_BATCH_SIZE` | Maximum pending outbox rows and unresolved mappings scanned per pass; clamped to 1–100 (default `25`) |
| `STRIPE_WEBHOOK_RECOVERY_LEASE_MS` | Leader and unresolved-record lease duration; clamped to 5 seconds–15 minutes (default `120000`) |
| `STRIPE_WEBHOOK_RECOVERY_BACKOFF_BASE_MS` | Initial exponential retry delay; clamped to 1 second–1 hour (default `30000`) |
| `STRIPE_WEBHOOK_RECOVERY_BACKOFF_MAX_MS` | Maximum exponential retry delay; never below the configured base (default `3600000`) |
| `STRIPE_WEBHOOK_RECOVERY_MAX_ATTEMPTS` | Attempt cap for poison outbox effects and unresolved mappings; clamped to 1–25 (default `8`) |
| `STRIPE_PRICE_PRO` | Stripe monthly Price ID for the `PRO` / Go tier |
| `STRIPE_PRICE_PRO_MAX` | Stripe monthly Price ID for the `PRO_MAX` / Plus tier |
| `STRIPE_PRICE_ENTERPRISE` | Stripe monthly Price ID for the `ENTERPRISE` / Pro tier |
| `PAYPAL_CLIENT_ID` | PayPal client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal client secret |
| `MERCADOPAGO_ACCESS_TOKEN` | Mercado Pago access token |

Paid-feature compatibility is intentionally narrow: a paid-plan user whose
`stripeSubscriptionId`, `subscriptionStatus`, and `subscriptionEndDate` are all
absent is treated as a legacy account and remains authorized. Once any
subscription field exists, paid-feature access requires `subscriptionStatus`
to be `active`, `trialing`, or `canceling` with a future
`subscriptionEndDate`;
unknown, canceled, past-due, expired-canceling, and other states fail closed.
Super-admin bypass behavior is unchanged.

Checkout terminal fencing is correlation-scoped: only lifecycle state for the
same Stripe subscription (or checkout session when no subscription ID exists)
can suppress a grant. A canceled or past-due subscription never blocks a
customer-validated replacement subscription.

Webhook recovery starts only after the database and HTTP server boot, uses a
PostgreSQL advisory lock plus a renewable `SystemSettings` lease so one replica
scans at a time, and stops before Prisma disconnects. It retries committed
`SubscriptionEvent.eventData` outbox effects and the redacted minimal unresolved
events under `stripe:webhook:unresolved:*`; it never stores the original Stripe
payload in the recovery record.

## 📧 Email (SMTP)

| Variable | Description | Default |
|----------|-------------|---------|
| `SMTP_HOST` | SMTP server host | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP username | (empty) |
| `SMTP_PASS` | SMTP password | (empty) |

## 📁 File Uploads

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_FILE_SIZE` | Max file size in MB | `50` |
| `UPLOAD_DIR` | Upload directory path | `uploads` |
| `UPLOAD_MAX_FILE_MB` | Alternative file size limit var | `50` |
| `MAX_UPLOAD_FILES` | Max files per upload request | `400` |
| `SIRAGPT_MAX_SIMULTANEOUS_DOCUMENTS` | Max documents attached/analyzed in one chat turn | `400` |
| `NEXT_PUBLIC_COMPOSER_MAX_FILES` | Browser composer max files per message | `400` |
| `SIRAGPT_XLSX_MAX_SHEETS` | Max worksheets extracted per XLSX workbook; extra sheets are skipped with an explicit marker | `5` |
| `SIRAGPT_XLSX_DEFANG_FORMULAS` | Prefix formula-like spreadsheet text with `'` during extraction to prevent formula injection on reuse | `true` |
| `OCR_MODE` | OCR processing mode | `hybrid` |
| `OCR_MIN_CONFIDENCE` | Minimum OCR confidence | `70` |
| `OCR_VISION_MODEL` | Vision model for OCR fallback | (auto) |
| `OCR_PDF_MAX_VARIANTS` | Local OCR variants per PDF page: normalize, contrast, threshold, adaptive, inverted | `4` |
| `OCR_PDF_DEEP_VARIANT_PAGES` | PDF pages that receive multi-variant OCR before falling back to the fastest pass | `60` |
| `OCR_PDF_PAGE_META_LIMIT` | Page-level OCR quality rows retained in analysis metadata | `200` |
| `OCR_PDF_MAX_CHARS` | Maximum OCR text characters retained from one PDF | `6000000` |
| `OCR_PDF_MAX_PAGES` | Maximum PDF pages to OCR; `0` means unlimited until runtime/resource limits | `0` |

## 🧪 Agent Runtime

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_QUEUE_NAME` | BullMQ queue name | `siragpt-agent-tasks` |
| `AGENT_WORKER_CONCURRENCY` | Concurrent agent workers | `2` |
| `AGENT_TASK_BOOT_RECOVERY_DISABLED` | Disable boot-time recovery of stale local task snapshots left `running`/`queued` after a process restart | `false` |
| `AGENT_TASK_BOOT_RECOVERY_STALE_MS` | Minimum snapshot age before boot recovery marks a local in-flight task as errored; BullMQ-backed snapshots are skipped when Redis is configured | `60000` |
| `AGENTIC_RAG_PROVIDER` | RAG provider for agents | `internal` |
| `AGENTIC_AGENT_ENGINE` | Agent reasoning engine | `react` |
| `SIRAGPT_USER_MEMORY_STORE` | Set to `pgvector` to store cross-session user memories in the `user_memories` pgvector table; empty keeps the existing RAG fallback | (empty) |
| `SIRAGPT_MEMORY_EMBED_PROVIDER` | Embedding provider for pgvector user memory: `voyage` or `jina` | `voyage` |
| `SIRAGPT_MEMORY_EMBED_MODEL` | Memory embedding model; must return 1024 dimensions | `voyage-3-large` |
| `VOYAGE_API_KEY` | Voyage AI key for 1024-dimension memory embeddings | (required when provider is `voyage`) |
| `JINA_API_KEY` | Jina AI key for 1024-dimension memory embeddings | (required when provider is `jina`) |

## 🧰 MCP Connectors

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_CONNECTOR_ALLOWLIST` | Comma-separated allowed MCP tools | (github.codex.status, etc.) |
| `GITHUB_CODEX_TOKEN` | GitHub token for codex connector | (optional) |
| `E2B_API_KEY` | E2B sandbox API key | (disabled) |
| `MCP_CODE_EXECUTE_ENABLED` | Enable code execution MCP | `false` |
| `MCP_WEB_FETCH_ENABLED` | Enable web fetch MCP | `false` |
| `SIRAGPT_MCP_ALLOWED_HOSTS` | Global comma-separated hostname ceiling for user-registered external MCP servers | empty (production MCP deny-all) |
| `SIRAGPT_MCP_ALLOW_HTTP` | Permit HTTP only for non-production loopback MCP endpoints | `0` |

External MCP registrations require HTTPS in production. Configure exact
hostnames or safe leading-* subdomain patterns such as
`*.tools.example.com`; wildcard matches are label-bound, exclude the apex, and
cannot target a public suffix such as `*.com` or `*.co.uk`. The runtime also
rejects userinfo, IP literals, private/reserved DNS results, and unsafe
non-default HTTPS ports. Optional `User.settings.mcpAllowedHosts` and
`Organization.settings.mcpAllowedHosts` restrictions intersect the global
allowlist and cannot expand it. The organization layer is used only for an
explicit, membership-verified active organization; personal chats use global
and user restrictions only. A missing production global allowlist activates
MCP deny-all, surfaces degraded MCP health, and does not prevent backend
startup. Development HTTP requires both a loopback URL and
`SIRAGPT_MCP_ALLOW_HTTP=1`.

## ⚙️ Idempotency

| Variable | Description | Default |
|----------|-------------|---------|
| `IDEMPOTENCY_ENABLED` | Enable idempotency middleware | `false` |
| `IDEMPOTENCY_TTL_SECONDS` | Cache TTL for idempotent responses | `86400` (24h) |

## 🧠 LLM Caching

| Variable | Description | Default |
|----------|-------------|---------|
| `SEMANTIC_CACHE_ENABLED` | Enable LLM response cache | `false` |
| `SEMANTIC_CACHE_TTL_SECONDS` | Cache TTL | `3600` |

## 💎 Credits Ledger (F2)

| Variable | Description | Default |
|----------|-------------|---------|
| `CREDITS_PARAPHRASE_PER_1K_CHARS` | Credits charged per 1,000 chars of text in `/api/paraphrase`. Multiplied by `Math.ceil(text.length / 1000)`. | `1` |
| `CREDITS_IMAGE_BASE` | Flat credit cost per image generation / variation / upscale via `/api/images/*`. Clamped to ≥ 1. | `5` |
| `CREDITS_VIDEO_BASE` | (Future) flat credit cost per video generation once `/api/video/jobs` switches to real providers. | `20` |
| `CREDITS_DEFAULT_REFILL_DAY` | Day-of-month for the monthly credits refill cron (F2 follow-up). | `1` |

## 🔐 RBAC (F1 + F2)

| Variable | Description | Default |
|----------|-------------|---------|
| `RBAC_CACHE_TTL_MS` | TTL (ms) for the `requirePermission()` cache. Enforce mode caps the non-Redis fallback at 5 seconds; every hit also verifies the durable permission version. | `60000` |
| `RBAC_ENFORCEMENT_MODE` | Explicit rollout mode: `shadow` permits the route-specific legacy admin predicate while logging RBAC differences; `enforce` requires a declarative global grant. Invalid values block production startup. | `enforce` in production; `shadow` otherwise |
| `RBAC_MUTATION_LOCK_TIMEOUT_MS` | Maximum PostgreSQL wait for the single cluster-wide transactional RBAC mutation lock (clamped to 25–5000 ms). Contention beyond this bound returns retryable HTTP 503 instead of waiting indefinitely. | `500` |
| `RBAC_REDIS_CONNECT_TIMEOUT_MS` | Bounded Redis socket-connect timeout for RBAC invalidation clients (clamped to 50–2000 ms). Offline queues are disabled. | `500` |
| `RBAC_REDIS_STARTUP_TIMEOUT_MS` | Maximum wait for RBAC Redis connect/subscribe during startup (clamped to 10–2000 ms). Failure degrades to a 5-second local cache and never blocks server boot. | `500` |
| `RBAC_REDIS_COMMAND_TIMEOUT_MS` | Maximum wait for Redis invalidation publication (clamped to 10–2000 ms). Timeout degrades to local invalidation so RBAC mutations cannot hang. | `500` |

Startup seeds the canonical roles, permissions, mappings, legacy/global, and
organization assignments idempotently. In `enforce`, the server binds no port
unless every legacy admin has the expected global assignment and `SUPERADMIN`
owns every system permission. `/health` and `/health/ready` expose only the
value-free RBAC state/error code. RBAC mutations atomically increment a
`SystemSettings` permission-version row; cache entries must match that durable
version as well as their in-process generation before reuse.

All RBAC writers share one stable PostgreSQL transaction-level advisory lock
key (`RBAC_MUTATION_LOCK_KEY` in `rbac-system-assignments.js`). Bootstrap,
dual-write, cleanup, lifecycle deletion, and control-plane grants/revocations
acquire it before rereading user and membership state. Bootstrap performs one
lock acquisition, set-based reconciliation, readiness verification, and marker
write in that order within one transaction.

## 🖼️ Image / 🎬 Video providers (F4)

| Variable | Description | Default |
|----------|-------------|---------|
| `IMAGE_PROVIDER` | `mock` (placeholder SVG) / `openai` (DALL-E) / `none` (503 every request). | `mock` |
| `STABILITY_API_KEY` | (Future) Stability AI key once `stability` provider lands. | — |
| `REPLICATE_API_TOKEN` | (Future) Replicate token once `replicate` provider lands. | — |
| `VIDEO_PROVIDER` | `mock` (SVG storyboard + UI disclaimer) / `pika` / `runway` / `none`. | `mock` |
| `PIKA_API_KEY` | Pika Labs REST key. Required when `VIDEO_PROVIDER=pika`. | — |
| `PIKA_WEBHOOK_SECRET` | HMAC secret Pika signs delivery webhooks with. Required for prod use. | — |
| `RUNWAY_API_KEY` | Runway Gen-3 REST key. Required when `VIDEO_PROVIDER=runway`. | — |
| `RUNWAY_WEBHOOK_SECRET` | HMAC secret Runway signs delivery webhooks with. | — |
| `IMAGE_GEN_QUEUE_CONCURRENCY` | (Future) BullMQ worker concurrency for image jobs. | `4` |
| `IMAGE_GEN_TIMEOUT_MS` | (Future) Per-job timeout before failing + auto-refund. | `120000` |
| `IMAGE_RETENTION_DAYS_FREE` | (Future) TTL for soft-deleted images on FREE plan. | `90` |

## 📈 Metrics (F5)

| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_TOKEN` | Optional dedicated bearer credential for non-loopback Prometheus scrapers. Compared in constant time and never written to logs. | — |
| `METRICS_ALLOW_LOOPBACK` | Permit direct socket-loopback metrics access in production. Ignored whenever `Forwarded` or `X-Forwarded-*` is present. | `false` |
| `METRICS_BIND` | (Future) Bind address for a dedicated metrics listener (e.g. `127.0.0.1:9090`). Today metrics ride on the main backend port (`5000`). | — |
| `SIRAGPT_METRICS_MAX_SERIES_PER_FAMILY` | Per-process cap for label series in both in-memory registries, clamped to `1..10000`. Counters/histograms fold overflow into `__other__`; gauges drop later unseen labels. | `500` |
| `SIRAGPT_SLO_MAX_ROUTE_STATES` | Cap for in-process SLO route aggregates, clamped to `1..2000`. Unseen routes beyond the cap fold into the stable `__other__` route. | `128` |

The canonical scrape path is `GET /metrics`; `GET /internal/metrics` and
`GET /api/se-agents/metrics` are compatibility aliases backed by the same
handler and exposition. A matching `Authorization: Bearer <METRICS_TOKEN>` or
a session-backed super-admin JWT is always accepted. Direct socket-loopback
bypass (`req.socket.remoteAddress`, never `req.ip`) is enabled by default only
outside production; production requires `METRICS_ALLOW_LOOPBACK=true`. Any
`Forwarded` or `X-Forwarded-*` header disables loopback bypass in every
environment, preventing a same-host reverse proxy from inheriting localhost
trust. API keys are denied on the super-admin fallback even when their owner is
a super-admin; `METRICS_TOKEN` is the dedicated machine-scrape credential. If
`METRICS_TOKEN` is unset, remote anonymous scraping remains disabled.
Invalid remote credentials return `401`; authenticated non-super-admin users
and API-key callers receive `403`.
If any required exporter fails, the handler returns a non-2xx response rather
than publishing a partial scrape; alert on scrape failures.

## 🚀 Frontend (NEXT_PUBLIC_*)

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API URL | `http://localhost:5000/api` |
| `NEXT_PUBLIC_URL` | Frontend URL | `http://localhost:3000` |
| `NEXT_PUBLIC_APP_NAME` | Application name | `siraGPT` |
| `NEXT_PUBLIC_APP_DESCRIPTION` | App description | `Multi-LLM AI Platform` |

Production Compose defaults `NEXT_PUBLIC_API_URL` to `https://api.siragpt.com/api` and `NEXT_PUBLIC_URL` to `https://siragpt.com`. Keep those values for the public deployment so OAuth callbacks stay on the API domain.

## OAuth public URLs

| Variable | Description | Production value |
|----------|-------------|------------------|
| `GOOGLE_AUTH_BASE_URL` | Public backend origin used to build Google OAuth callbacks | `https://api.siragpt.com` |
| `GOOGLE_AUTH_URI` | Login callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/google/callback` |
| `GOOGLE_REDIRECT_URI` | Gmail integration callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/gmail/callback` |
| `GOOGLE_REDIRECT_CALENDAR_DRIVE_URI` | Calendar/Drive integration callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/google-services/callback` |
| `GITHUB_OAUTH_REDIRECT_URI` | GitHub callback registered in the OAuth App | `https://api.siragpt.com/api/github/callback` |
| `GITHUB_OAUTH_SUCCESS_REDIRECT` | GitHub post-callback browser destination | `https://siragpt.com/settings` |
| `SPOTIFY_REDIRECT_URI` | Spotify callback registered in the developer dashboard | `https://api.siragpt.com/api/spotify/callback` |
| `SPOTIFY_OAUTH_SUCCESS_REDIRECT` | Spotify success browser destination | `https://siragpt.com/chat` |
| `SPOTIFY_OAUTH_FAILURE_REDIRECT` | Spotify failure browser destination | `https://siragpt.com/connections` |
| `GOOGLE_ALLOW_FRONTEND_CALLBACK` | Set to `true` only for same-origin deployments where the frontend domain intentionally proxies OAuth callbacks | unset |

In production, every provider callback and post-callback must use HTTPS and
must not resolve to localhost. SiraGPT also rejects frontend-domain Google
callbacks when the API has its own public host. These checks prevent
`redirect_uri_mismatch` regressions and session-bearing redirects to an
insecure origin.

---

## Advanced: WebAuthn (Passkeys)

| Variable | Description |
|----------|-------------|
| `WEBAUTHN_RP_ID` | WebAuthn relying party ID (your domain) |
| `WEBAUTHN_ORIGIN` | WebAuthn allowed origin(s) |
| `WEBAUTHN_ENABLED` | Enable WebAuthn support |
| `WEBAUTHN_ENDPOINTS_ENABLED` | Mount WebAuthn HTTP routes |

## Advanced: SSE & Streaming

| Variable | Description | Default |
|----------|-------------|---------|
| `SSE_HEARTBEAT_INTERVAL_MS` | SSE keepalive interval | `25000` (25s) |
| `STREAM_CACHE_MAX_ENTRIES` | Max in-flight stream cache | `1000` |
