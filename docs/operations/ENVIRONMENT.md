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
| `PRISMA_DATABASE_URL` | PostgreSQL connection string | — | Format: `postgresql://user:pass@host:5432/db` |

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
| `POSTGRES_USER` | PostgreSQL user | `postgres` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `postgres` |
| `POSTGRES_DB` | PostgreSQL database name | `siragpt` |
| `PRISMA_DATABASE_URL` | Canonical Prisma datasource URL | — |
| `DATABASE_URL` | Legacy fallback used only when `PRISMA_DATABASE_URL` is empty | — |
| `DATABASE_POOL_MIN` | Informational lower pool bound used by instrumentation; clamped to `1..DATABASE_POOL_MAX` | `2` |
| `DATABASE_POOL_MAX` | Prisma v6 `connection_limit`; strictly parsed and clamped to `1..100` | `10` |
| `DATABASE_POOL_TIMEOUT_MS` | Pool acquisition timeout in milliseconds, clamped to `1000..300000` and rounded up to Prisma `pool_timeout` seconds | `10000` |
| `DATABASE_POOL_AUTOSCALE_ENABLED` | Start the advisory pool recommendation loop. It never replaces or resizes the live Prisma client. | `false` |
| `DATABASE_POOL_AUTOSCALE_INTERVAL_MS` | Advisory sampling interval in milliseconds, clamped to `1000..3600000` | `30000` |
| `DATABASE_POOL_AUTOSCALE_MIN` | Lowest limit the advisory policy may recommend, clamped to `1..100` | `2` |
| `DATABASE_POOL_AUTOSCALE_MAX` | Highest limit the advisory policy may recommend, clamped to `1..100` and never below min | `50` |
| `DATABASE_POOL_AUTOSCALE_COLD_SAMPLES` | Consecutive cold samples required before a scale-down recommendation, strictly parsed and clamped to `1..20` | `3` |

`PRISMA_DATABASE_URL` takes precedence. If it and `DATABASE_URL` are both
non-empty, their trimmed values must match; otherwise startup fails closed
without including either value in the error. For direct `postgres:` and
`postgresql:` URLs, the runtime builder preserves unrelated parameters such as
`schema`, `sslmode`, and `pgbouncer`, while replacing only `connection_limit`
and `pool_timeout`. It never rewrites `prisma+postgres:` remote/Accelerate
URLs, whose local pool capacity is reported as unobservable.

For observable direct connections, full `GET /health` reports estimated
active/idle connections and estimated saturation plus any advisory
recommendation. Label-free bounded gauges are exported from `GET /metrics`.
Remote capacity omits those local estimates and recommendations. Datasource
URLs and credentials are never included in pool logs.

## 🔒 Security

| Variable | Description | Default |
|----------|-------------|---------|
| `CORS_ORIGINS` | Comma-separated allowed origins | `http://localhost:3000` |
| `CSP_ENABLED` | Enable Content Security Policy | `true` |
| `CSP_REPORT_ONLY` | Report-only mode (vs enforcement) | `true` |
| `CSP_REPORT_URI` | CSP violation report endpoint | (empty) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms | `900000` (15 min) |
| `RATE_LIMIT_AUTH_MAX` | Max auth requests per window | `30` |
| `RATE_LIMIT_EXPENSIVE_MAX` | Max expensive requests per window | `60` |
| `RATE_LIMIT_API_MAX` | Max API requests per window | `1000` |
| `RATE_LIMIT_STORE` | Rate limit store backend | `auto` (Redis or memory) |
| `SIRAGPT_REDACT_EXTRA_HEADERS` | Optional comma-separated header names to redact from logs/traces in addition to the built-in deny list | (empty) |
| `SIRAGPT_REDACT_EXTRA_QUERY_KEYS` | Optional comma-separated query parameter names to redact from logs/traces in addition to the built-in deny list | (empty) |
| `PLAN_QUOTAS_ENFORCED` | Enforce plan-based token quotas | `true` |

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
| `INTERNAL_HEALTH_TOKEN` | Dedicated bearer credential for remote `/internal/health/*` access. When unset, `METRICS_TOKEN` is the machine-token fallback. | — |
| `INTERNAL_HEALTH_ALLOW_LOOPBACK` | Permit direct socket-loopback access to internal health in production. Ignored whenever `Forwarded` or `X-Forwarded-*` is present. | `false` |
| `HEALTH_PROBE_INTERVAL_MS` | Internal health-history scheduler interval in ms, clamped to Node's safe timer range 1000–2147483647 | `30000` |
| `HEALTH_PROVIDER_PROBES_ENABLED` | Register configured `provider-*` probes. Disabled by default to avoid exposing paid/rate-limited checks. | `false` |
| `HEALTH_SCHEDULE_PROVIDER_PROBES` | Periodically poll registered `provider-*` probes. Effective only when `HEALTH_PROVIDER_PROBES_ENABLED=true`. | `false` |
| `HEALTH_QUEUE_PROBE_TIMEOUT_MS` | Timeout for each dedicated BullMQ health operation, clamped to 100–10000 ms | `1500` |
| `HEALTH_QUEUE_PROBE_CACHE_TTL_MS` | Dedicated queue-health result cache TTL, clamped to 0–5000 ms | `1000` |
| `HEALTH_CRITICAL_QUEUES` | Comma-separated queue IDs/names whose probe failure makes readiness unhealthy. Known IDs: `agent-task`, `chat-run`, `codex-runs`, `document-collections`, `goal-runs`. | (none) |

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
| `STRIPE_PRICE_PRO` | Stripe monthly Price ID for the `PRO` / Go tier |
| `STRIPE_PRICE_PRO_MAX` | Stripe monthly Price ID for the `PRO_MAX` / Plus tier |
| `STRIPE_PRICE_ENTERPRISE` | Stripe monthly Price ID for the `ENTERPRISE` / Pro tier |
| `PAYPAL_CLIENT_ID` | PayPal client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal client secret |
| `MERCADOPAGO_ACCESS_TOKEN` | Mercado Pago access token |

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
| `RBAC_CACHE_TTL_MS` | TTL (ms) for the in-memory `requirePermission()` permission cache. Lower = fresher, higher = cheaper. | `60000` |
| `RBAC_SHADOW_MODE` | When `true`, `requirePermission()` allows `req.user.isSuperAdmin` to bypass the declarative check (and logs `kind: 'rbac.shadow.diff'`). Flip to `false` in F5 PR23 sunset once logs show zero diffs for ≥ 7 days. | `true` |

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

## Google OAuth Public URLs

| Variable | Description | Production value |
|----------|-------------|------------------|
| `GOOGLE_AUTH_BASE_URL` | Public backend origin used to build Google OAuth callbacks | `https://api.siragpt.com` |
| `GOOGLE_AUTH_URI` | Login callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/google/callback` |
| `GOOGLE_REDIRECT_URI` | Gmail integration callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/gmail/callback` |
| `GOOGLE_REDIRECT_CALENDAR_DRIVE_URI` | Calendar/Drive integration callback registered in Google Cloud Console | `https://api.siragpt.com/api/auth/google-services/callback` |
| `GOOGLE_ALLOW_FRONTEND_CALLBACK` | Set to `true` only for same-origin deployments where the frontend domain intentionally proxies OAuth callbacks | unset |

In production, SiraGPT rejects localhost callbacks and frontend-domain Google callbacks when the API has its own public host. This prevents `redirect_uri_mismatch` regressions when `siragpt.com` serves the UI and `api.siragpt.com` serves the backend.

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
