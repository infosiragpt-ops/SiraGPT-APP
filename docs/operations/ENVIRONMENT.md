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
| `DEEPSEEK_API_KEY` | DeepSeek API key |

## 🗄️ Database & Cache

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `POSTGRES_USER` | PostgreSQL user | `postgres` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `postgres` |
| `POSTGRES_DB` | PostgreSQL database name | `siragpt` |

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

## 💳 Payments

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
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
| `MAX_UPLOAD_FILES` | Max files per upload | `10` |
| `SIRAGPT_XLSX_MAX_SHEETS` | Max worksheets extracted per XLSX workbook; extra sheets are skipped with an explicit marker | `5` |
| `SIRAGPT_XLSX_DEFANG_FORMULAS` | Prefix formula-like spreadsheet text with `'` during extraction to prevent formula injection on reuse | `true` |
| `OCR_MODE` | OCR processing mode | `hybrid` |
| `OCR_MIN_CONFIDENCE` | Minimum OCR confidence | `70` |
| `OCR_VISION_MODEL` | Vision model for OCR fallback | (auto) |

## 🧪 Agent Runtime

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_QUEUE_NAME` | BullMQ queue name | `siragpt-agent-tasks` |
| `AGENT_WORKER_CONCURRENCY` | Concurrent agent workers | `2` |
| `AGENTIC_RAG_PROVIDER` | RAG provider for agents | `internal` |
| `AGENTIC_AGENT_ENGINE` | Agent reasoning engine | `react` |

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
