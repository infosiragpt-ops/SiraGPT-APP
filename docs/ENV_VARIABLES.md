# SirAGPT — Environment Variables Reference

> Generated from the internal orchestration upgrade. All variables below are
> consumed by the Express backend (`backend/index.js`) and its orchestration
> layer (`backend/src/orchestration/`). None affect the Next.js frontend UI.

---

## LLM Providers (Multi-Provider Gateway)

| Variable | Provider | Purpose | Default Model |
|----------|----------|---------|---------------|
| `ANTHROPIC_API_KEY` | Anthropic | Claude Opus 4.7, Sonnet 4.6, Haiku 4.5 | `claude-sonnet-4-6` |
| `OPENROUTER_API_KEY` | OpenRouter | Primary gateway; delegates to 300+ models | varies by routing |
| `XAI_API_KEY` | xAI / Grok | Grok chat plus `/api/voice/grok` STT/TTS | `grok-4.3`, `grok-stt`, voice `eve` |
| `OPENAI_API_KEY` | OpenAI | GPT-4o, GPT-4o-mini, embeddings legacy | `gpt-4o` |
| `GOOGLE_AI_API_KEY` | Google AI Studio | Gemini 2.5 Pro, Gemini 2.5 Flash | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Groq Cloud | Llama 3.3 70B, DeepSeek R1 Distill | `llama-3.3-70b-versatile` |
| `CEREBRAS_API_KEY` | Cerebras Inference | Ultra-fast inference | `llama-3.3-70b` |
| `MISTRAL_API_KEY` | Mistral La Plateforme | Mistral Large, Small, Codestral | `mistral-large-latest` |
| `DEEPSEEK_API_KEY` | DeepSeek API | DeepSeek Chat, DeepSeek Reasoner | `deepseek-chat` |

### Free-Tier Fallback Model

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMA4_MODEL_ID` | `Gema4-31B` | Model id used when the FREE plan or exhausted premium pools route to the Gema4 fallback |
| `GEMA4_PROVIDER` | `OpenAI` | Provider client used for the configured Gema4 fallback model |
| `GEMA4_DISPLAY_NAME` | `Gema4 31B` | Public display name returned by `/api/ai/models` |
| `GEMA4_ICON` | `ChatGPTLogo` | Icon key returned with the virtual fallback model |

### Embedding Providers

| Variable | Provider | Purpose |
|----------|----------|---------|
| `VOYAGE_API_KEY` | Voyage AI | Primary embeddings (`voyage-3-large`), recommended by Anthropic |
| `JINA_API_KEY` | Jina AI | Fallback embeddings, v3 multilingual |

### Gateway Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_LLM_GATEWAY_TIMEOUT_MS` | `45000` | Per-call timeout for LLM invocations |
| `SIRAGPT_LLM_GATEWAY_BREAKER_RESET_MS` | `60000` | Circuit breaker reset timeout (opossum) |
| `SIRAGPT_LLM_MAX_TOKENS` | `4096` | Max tokens per LLM call |

---

## Search Tools

| Variable | Provider | Purpose |
|----------|----------|---------|
| `TAVILY_API_KEY` | Tavily API | Primary web search tool for agents |
| `EXA_API_KEY` | Exa AI | Semantic academic search fallback |
| `FIRECRAWL_API_KEY` | Firecrawl | Deep page scraping (self-hosted optional) |

---

## Observability

| Variable | Purpose |
|----------|---------|
| `LANGFUSE_PUBLIC_KEY` | Langfuse Cloud/self-hosted public key |
| `LANGFUSE_SECRET_KEY` | Langfuse Cloud/self-hosted secret key |
| `LANGFUSE_HOST` | Langfuse host URL (defaults to cloud) |
| `SENTRY_DSN` | Sentry error reporting DSN |
| `OTEL_ENABLED` | Enable OpenTelemetry tracing (`true`/`false`) |

---

## Semantic Cache (Upstash Redis)

| Variable | Purpose |
|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST API URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST API token |
| `SIRAGPT_SEMANTIC_CACHE_TTL_QUICK` | TTL seconds for speed queries (default: 300) |
| `SIRAGPT_SEMANTIC_CACHE_TTL_DEEP` | TTL seconds for deep reasoning (default: 3600) |
| `SIRAGPT_SEMANTIC_CACHE_TTL_DEFAULT` | TTL seconds default (default: 600) |

---

## Storage (Cloudflare R2)

| Variable | Purpose |
|----------|---------|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key |
| `R2_BUCKET_NAME` | R2 bucket name for artifacts |
| `R2_ENDPOINT` | R2 endpoint override (auto-resolved from ACCOUNT_ID) |

---

## Multichannel (OpenClaw)

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_API_KEY` | API key for SiraGPT→OpenClaw auth |
| `OPENCLAW_GATEWAY_URL` | OpenClaw gateway URL (default: `http://openclaw:8787`) |
| `SIRAGPT_INTERNAL_API_URL` | Backend URL OpenClaw calls into (default: `http://siragpt-backend:5000`) |

---

## Security / Middleware

| Variable | Default | Purpose |
|----------|---------|---------|
| `CSRF_DISABLED` | `0` | Disable CSRF double-submit protection (test env only) |
| `CSRF_PEPPER` | (derived from JWT_SECRET) | HMAC pepper for CSRF token hashing |
| `CORS_ORIGINS` | localhost in development; required in production | Comma-separated exact-origin allowlist; wildcard is rejected in production |
| `FRONTEND_URL` | `http://localhost:3000` outside production | Canonical browser origin used for the token-free SAML `303` completion redirect |
| `TRUST_PROXY_HOPS` | `0` | Number of known reverse-proxy hops Express may trust; production Compose pins the single Caddy hop |
| `TRUST_PROXY_CIDR` | (empty) | Alternative comma-separated exact proxy CIDRs; mutually exclusive with `TRUST_PROXY_HOPS` |
| `CSP_ENABLED` | `0` in development, `1` in production | Enable Content-Security-Policy |
| `CSP_REPORT_ONLY` | `1` | CSP report-only mode |
| `JWT_SECRET` | required | JWT signing secret |
| `SAML_REQUEST_TTL_MS` | `300000` | Lifetime for SP-initiated AuthnRequest IDs and RelayState (clamped to 1–15 minutes) |
| `SAML_REQUEST_CACHE_MAX_ENTRIES` | `5000` | Maximum live SAML request/state entries in the bounded cache |
| `SAML_REDIS_CONNECT_TIMEOUT_MS` | `500` | Redis connection deadline for SAML request state (10–2000 ms) |
| `SAML_REDIS_COMMAND_TIMEOUT_MS` | `500` | ioredis and wrapper deadline for every SAML cache command (10–2000 ms) |
| `SAML_REDIS_RETRY_BASE_MS` | `100` | Initial SAML Redis initialization retry delay (10–5000 ms) |
| `SAML_REDIS_RETRY_MAX_MS` | `5000` | Maximum exponential-backoff delay for SAML Redis initialization (10–60000 ms) |
| `SAML_REDIS_PREFIX` | `sira:saml:` | Dedicated Redis namespace for SAML request/state keys |
| `SAML_RELAY_STATE_SECRET` | (derived from `JWT_SECRET`) | Optional dedicated HMAC secret for signed RelayState |
| `SAML_ACS_BODY_LIMIT_BYTES` | `262144` | Exact ACS URL-encoded body limit, clamped to 64–512 KiB |
| `SAML_ACS_RATE_LIMIT_MAX` | `30` | Maximum exact ACS POST attempts per normalized IP bucket/window |
| `SAML_ACS_RATE_LIMIT_WINDOW_MS` | `60000` | Exact ACS distributed limiter window (1 second–15 minutes) |

Cookie-authenticated state-changing requests under `/api/*` use the CSRF
double-submit guard. Safe methods and Bearer/API-key clients bypass it. The
Stripe webhook is exempt only at the exact signed webhook path. A standard
`SAMLResponse` POST bypasses Sira CSRF only at the exact
`/api/auth/sso/:orgSlug/callback` assertion-consumer path; SAML signature and
InResponseTo/replay validation still run. Public generated-app mounts
(`/api/apps-ai`, `/api/apps-kv`) remain cookieless. Production requires a
valid explicit `CORS_ORIGINS`, rejects wildcards and enabled `CSRF_DISABLED`,
and requires cookie-auth mutations to send a trusted Origin plus
`Sec-Fetch-Site: same-origin|same-site`.

SP-initiated SAML starts at `GET /api/auth/sso/:orgSlug/login`, where
`@node-saml/node-saml` generates an AuthnRequest and redirects to the IdP.
Each request uses `validateInResponseTo: 'always'`, a short-lived request ID,
and signed one-time RelayState bound to the organization and request. The ACS
also verifies exact Destination and configured Audience before provisioning.
In production, Redis is mandatory for this state and an unavailable store
fails closed with `503`, `Cache-Control: no-store`, and `Retry-After`; bounded
memory fallback exists only outside production. A bounded exponential-backoff
Redis circuit remains fail-closed per attempt and recovers on a later request
without a process restart.

RelayState is also bound to the initiating browser by a high-entropy pre-auth
nonce cookie. It is `HttpOnly`, narrowly scoped to that organization's ACS,
and uses `SameSite=None` (`Secure` in production) for the cross-site SAML POST.
Redis stores only the nonce's SHA-256 hash. The ACS atomically compares and
consumes the hash and clears the cookie, so another browser cannot complete or
burn the initiating browser's login.

On success the form ACS sets the normal session cookie, issues the existing
CSRF cookie pair, and sends a `303` to the `/auth/callback` path on the
validated origin of `FRONTEND_URL`, without a JWT in the URL or response body.
Trusted API/test callers may request JSON only with both
`Accept: application/json` and `X-Sira-Response-Mode: json`; that response also
omits the JWT. IdP CORS is not required:
the exact URL-encoded ACS POST bypasses credentialed app CORS and emits no
credentialed CORS headers, while OIDC GET and all sibling auth routes keep
the normal allowlist. A dedicated fail-closed ACS rate limiter runs before its
bounded body parser and request telemetry; production Redis outages return
`503`, exhausted buckets return `429`, and oversized bodies return `413`.

---

## Rate Limiting

| Variable | Default | Purpose |
|----------|---------|---------|
| `RATE_LIMIT_AUTH_MAX` | `30` | Max auth requests per window |
| `RATE_LIMIT_EXPENSIVE_MAX` | `180` | Max expensive (LLM) requests per window |
| `RATE_LIMIT_API_MAX` | `3000` | Max general API requests per window |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 min) | Rate limit window duration |
| `RATE_LIMIT_STORE` | `auto` (`redis` in Compose) | General store selection: `auto`, `redis`, or `memory` |
| `RATE_LIMIT_REDIS_PREFIX` | `rl:` | Redis key prefix for rate limit counters |
| `RATE_LIMIT_SENSITIVE_POLICY` | `distributed` in production | Sensitive auth/API-key/billing policy: `distributed`, `memory`, or `fail-open`; production accepts only `distributed` |
| `RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS` | `1000` | Per-command/pipeline ioredis and outer wrapper timeout (10–30000 ms) |
| `RATE_LIMIT_STORE_RETRY_AFTER_SECONDS` | `5` | `Retry-After` for fail-closed 503 responses (1–300 seconds) |
| `RATE_LIMIT_BILLING_CHECKOUT_MAX` | `10` | Checkout attempts per user |
| `RATE_LIMIT_BILLING_CHECKOUT_IP_MAX` | `100` | Checkout attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_VERIFY_MAX` | `20` | Checkout verification attempts per user |
| `RATE_LIMIT_BILLING_VERIFY_IP_MAX` | `200` | Verification attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_MAX` | `5` | Plan/subscription mutations per user |
| `RATE_LIMIT_BILLING_PLAN_CHANGE_IP_MAX` | `50` | Plan/subscription mutations per normalized shared IP |
| `RATE_LIMIT_BILLING_WINDOW_MS` | `900000` | Checkout and verification window |
| `RATE_LIMIT_BILLING_PLAN_WINDOW_MS` | `3600000` | Plan/subscription mutation window |
| `RATE_LIMIT_BILLING_REFUND_MAX` | `5` | Admin grant/refund attempts per admin |
| `RATE_LIMIT_BILLING_REFUND_IP_MAX` | `50` | Admin grant/refund attempts per normalized shared IP |
| `RATE_LIMIT_BILLING_REFUND_WINDOW_MS` | `3600000` | Admin refund window |
| `SIRAGPT_API_KEY_AUDIT_COUNTER_MAX` | `10000` | Maximum in-process API-key audit-sampling counters |

Billing atomically consumes its user and IP dimensions, with a higher IP
ceiling for offices and carrier NAT. IPv6 addresses are grouped by `/64`;
IPv4 is canonicalized from Express `req.ip`/the socket only, never raw
`X-Forwarded-For`. Production startup rejects a missing Redis URL,
process-memory sensitive limiting, and `memory`/`fail-open` sensitive
policies. The general catch-all API limiter remains fail-open on store errors
so a Redis incident does not brick unrelated API reads.

---

## Database / Session

| Variable | Purpose |
|----------|---------|
| `PRISMA_DATABASE_URL` | Runtime Prisma datasource; direct PostgreSQL or remote `prisma+postgres:` |
| `DIRECT_DATABASE_URL` | Direct PostgreSQL datasource for migrations, pg preflight, and advisory locking |
| `DATABASE_URL` | Legacy runtime fallback and direct-migration candidate |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | PostgreSQL TLS certificate verification; defaults to `true`, disabled only by explicit `false` |
| `DATABASE_SSL_CA` | Optional inline PEM CA or CA file path; overrides URL `sslrootcert` and is never logged |
| `DATABASE_SSL_CERT` | Optional inline PEM client certificate or file path; overrides URL `sslcert` and is never logged |
| `DATABASE_SSL_KEY` | Optional inline PEM client private key or file path; overrides URL `sslkey` and is never logged |
| `POSTGRES_HOST` | Host used for the POSTGRES-only local compatibility fallback |
| `POSTGRES_PORT` | Port used for the POSTGRES-only local compatibility fallback (default `5432`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials and database used by the POSTGRES-only fallback |
| `MIGRATION_COMMAND_TIMEOUT_MS` | Per-Prisma-child hard deadline (default `300000`) |
| `BOOT_COMMAND_TIMEOUT_MS` | Auxiliary boot-command deadline, including `fuser` cleanup (default `5000`) |
| `MIGRATION_DB_CONNECT_TIMEOUT_MS` | Boot `pg` connection timeout (default `10000`) |
| `MIGRATION_DB_QUERY_TIMEOUT_MS` | Boot `pg` query timeout (default `15000`) |
| `MIGRATION_DB_STATEMENT_TIMEOUT_MS` | Boot PostgreSQL statement timeout (default `15000`) |
| `MIGRATION_LOCK_TIMEOUT_MS` | Total lock deadline including connect/query (default `120000`) |
| `MIGRATION_ALLOW_EQUIVALENT_UNBASELINED` | Temporary no-schema U1 compatibility: P3005 may return `schema_equivalent_unbaselined` only after a bounded zero diff; never changes migration history (default `0`) |
| `SKIP_MIGRATIONS` | Skip migrations during normal local boot only; rejected by `--migrate-only` (default `0`) |
| `MIGRATION_NONFATAL` | Explicit degraded policy for normal boot only; `--migrate-only` remains strict |
| `DATABASE_POOL_MIN` | Instrumentation lower bound (default `2`, capped by max) |
| `DATABASE_POOL_MAX` | Prisma v6 `connection_limit` (default `10`, clamp `1..100`) |
| `DATABASE_POOL_TIMEOUT_MS` | Prisma acquire timeout in ms (default `10000`, clamp `1000..300000`, rounded up to `pool_timeout` seconds) |
| `DATABASE_POOL_AUTOSCALE_ENABLED` | Enable advisory-only pool recommendations; never resizes live Prisma |
| `DATABASE_POOL_AUTOSCALE_INTERVAL_MS` | Recommendation sampling interval (default `30000`, clamp `1000..3600000`) |
| `DATABASE_POOL_AUTOSCALE_MIN` | Advisory recommendation floor (default `2`, clamp `1..100`) |
| `DATABASE_POOL_AUTOSCALE_MAX` | Advisory recommendation ceiling (default `50`, clamp `1..100` and never below min) |
| `DATABASE_POOL_AUTOSCALE_COLD_SAMPLES` | Consecutive cold samples before advisory scale-down (default `3`, clamp `1..20`) |
| `REDIS_URL` | Redis connection string (sessions, queues, rate limits, cache) |
| `SESSION_SECRET` | Express session signing secret |

Local pool URL controls and estimated capacity telemetry apply only to direct
`postgres:`/`postgresql:` datasources. `prisma+postgres:` remote/Accelerate
URLs are not rewritten and expose capacity as unobservable, so local pool
estimates and recommendations are omitted.

Runtime resolution prefers `PRISMA_DATABASE_URL` and uses `DATABASE_URL` only
as fallback. Direct migration resolution prefers `DIRECT_DATABASE_URL`, then a
direct `DATABASE_URL`, then a direct `PRISMA_DATABASE_URL`. A remote runtime and
different direct migration URL are valid; conflicting aliases for one role
fail closed without logging values. Remote-only migration startup exits with
`DIRECT_DATABASE_URL_REQUIRED` instead of copying the remote URL.

When all three URL roles are empty, the pure resolver may synthesize one local
runtime/direct URL from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`. Any explicit URL disables synthesis:
a direct `PRISMA_DATABASE_URL` remains the migration fallback, while a remote
`PRISMA_DATABASE_URL` without a direct URL fails closed.

Boot-time PostgreSQL connections map URL `sslrootcert`/`sslcert`/`sslkey` to
an explicit `pg` `ssl.ca`/`cert`/`key` object, then strip URL-level SSL
controls so they cannot override it. `DATABASE_SSL_CA`, `DATABASE_SSL_CERT`,
and `DATABASE_SSL_KEY` take precedence per field. Each accepts inline PEM or a
regular PEM file up to 1 MiB; certificate and key must be paired. Unusable URL
material fails with a stable value-free code, and contents/paths are never
logged. Insecure or conflicting URL modes fail closed unless
`DATABASE_SSL_REJECT_UNAUTHORIZED=false` is explicit.

P3005 never auto-baselines or invokes `prisma migrate resolve`. The temporary
`MIGRATION_ALLOW_EQUIVALENT_UNBASELINED=1` path is limited to the no-schema U1
rollout: a bounded zero diff returns the logged
`schema_equivalent_unbaselined` result without retrying migration or changing
history; drift fails. U0 must perform a reviewed one-off migration-history
baseline before schema-bearing units. Release `--migrate-only` fails non-zero
on preflight, lock, migration, release, or `SKIP_MIGRATIONS=1`; only normal
local boot may skip or use `MIGRATION_NONFATAL=1`.

---

## General

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | Express backend port |
| `NODE_ENV` | `development` | Environment: `development`, literal `production`, or `test`; the `prod` alias is rejected at startup |
| `SIRAGPT_RESEARCH_EMAIL` | — | Email for polite User-Agent in scientific search |
| `IDEMPOTENCY_ENABLED` | `false` | Enable Stripe-style replay protection |
| `MAINTENANCE_MODE_ENABLED` | `false` | Enable 503 maintenance mode |

---

## Optional Scientific Search Keys

| Variable | Provider | Purpose |
|----------|----------|---------|
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar | Higher rate limits |
| `NCBI_API_KEY` | NCBI PubMed | Higher rate limits |
| `CORE_API_KEY` | CORE | Higher rate limits |

---

## Document Pipeline Parsers

| Variable | Default | Purpose |
|----------|---------|---------|
| `MARKER_BIN` | `marker` | Path to Marker Python CLI for PDF parsing |
| `MARKER_TIMEOUT_MS` | `120000` | Marker process timeout in ms |
| `DOCLING_BIN` | `docling` | Path to Docling Python CLI for technical documents |
| `DOCLING_TIMEOUT_MS` | `120000` | Docling process timeout in ms |
| `MARKITDOWN_BIN` | `markitdown` | Path to MarkItDown CLI for Office docs |
| `MARKITDOWN_TIMEOUT_MS` | `60000` | MarkItDown process timeout in ms |
| `SIRAGPT_SEMANTIC_CHUNK_SIZE` | `1200` | Semantic chunking character size |
| `SIRAGPT_SEMANTIC_CHUNK_OVERLAP` | `200` | Semantic chunk overlap characters |

---

## Web Scraping (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `FIRECRAWL_HOST` | `https://api.firecrawl.dev` | Firecrawl API host (cloud or self-hosted) |
| `SEARXNG_URL` | — | SearXNG self-hosted meta-search JSON API URL |

---

## Helicone Proxy (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `HELICONE_API_KEY` | — | Helicone observability proxy API key |
| `HELICONE_BASE_URL` | `https://oai.helicone.ai` | Helicone proxy base URL |

---

## CrewAI Bridge (Optional)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_CREWAI_MODEL` | `gpt-4o-mini` | Model used by CrewAI Python workflows |
| `SIRAGPT_MULTI_AGENT_FRAMEWORK` | `builtin` | `builtin` or `crewai` |

---

## Security Middleware

| Variable | Default | Purpose |
|----------|---------|---------|
| `SIRAGPT_INPUT_SANITIZER_MODE` | `block` | XSS/prompt injection mode: `block`, `warn`, `off` |
