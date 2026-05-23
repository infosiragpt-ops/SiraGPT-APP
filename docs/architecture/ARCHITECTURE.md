# 🏗️ siraGPT — Architecture Overview

## System Context

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Browser    │ ───> │   Next.js    │ ───> │   Express    │
│  (React)     │      │  Frontend    │      │   Backend    │
└──────────────┘      └──────────────┘      └──────┬───────┘
                                                    │
                    ┌───────────────────────────────┤
                    │                               │
                    ▼                               ▼
            ┌──────────────┐              ┌──────────────┐
            │  PostgreSQL  │              │    Redis     │
            │  (Prisma)    │              │  (BullMQ)    │
            └──────────────┘              └──────────────┘
```

## Frontend

- **Framework:** Next.js 14+ (App Router)
- **State:** React Context + custom hooks
- **UI:** Tailwind CSS + shadcn/ui components
- **Analytics:** PostHog (client-side)
- **Error tracking:** Sentry (via `@sentry/nextjs`)

## Backend

- **Runtime:** Node.js 22+
- **Framework:** Express.js
- **Database ORM:** Prisma (PostgreSQL 16)
- **Queue:** BullMQ (Redis-backed)
- **Auth:** Passport.js (JWT + Google OAuth + WebAuthn)
- **Validation:** Zod (API contracts)

### Key Backend Layers

```
HTTP Request
    │
    ▼
┌─────────────────────────────────┐
│  Security Middleware            │
│  ├─ Helmet (headers + CSP)     │
│  ├─ CORS (origin allowlist)    │
│  ├─ Rate Limiting (3 tiers)    │
│  └─ Idempotency (POST/PUT)     │
├─────────────────────────────────┤
│  Parsing Middleware             │
│  ├─ Compression                │
│  ├─ JSON/URL-encoded body      │
│  └─ Cookie parser              │
├─────────────────────────────────┤
│  Observability Middleware       │
│  ├─ Pino (structured logging)  │
│  ├─ Request ID correlation     │
│  ├─ OpenTelemetry traces       │
│  └─ Morgan (dev access log)    │
├─────────────────────────────────┤
│  Auth Middleware                │
│  ├─ JWT verification           │
│  ├─ Passport session           │
│  ├─ Agent API keys             │
│  └─ Admin role check           │
├─────────────────────────────────┤
│  Route Handlers (40+)          │
│  ├─ /api/chat                  │
│  ├─ /api/agent                 │
│  ├─ /api/rag                   │
│  ├─ /api/files                 │
│  ├─ /api/payments              │
│  ├─ /api/search                │
│  └─ ... (30+ more)            │
├─────────────────────────────────┤
│  Error Handler                  │
│  └─ JSON error response        │
└─────────────────────────────────┘
    │
    ▼
HTTP Response
```

### Health Probes

| Endpoint | Purpose | Returns 503 if |
|----------|---------|----------------|
| `/health/live` | Liveness (k8s/Docker) | Never (process is alive) |
| `/health/ready` | Readiness (load balancer) | DB, Redis, or queue unhealthy |
| `/health` | Full composite health | Any critical dependency unhealthy |

### Rate Limiting Tiers

| Tier | Routes | Default Limit/Window | Bucket Identity |
|------|--------|---------------------|-----------------|
| Auth | `/api/auth/*` | 30 / 15 min | IP-based |
| Expensive | `/api/agent`, `/api/rag`, `/api/document-ai` | 60 / 15 min | JWT user ID or IP |
| API | Everything else under `/api/` | 1000 / 15 min | JWT user ID or IP |

### Key Infrastructure Decisions

1. **Single-process by design** — The health/readiness probe gates traffic when Redis is down, so in-memory rate-limit counters are safe. Multi-instance horizontal scaling would use `rate-limit-redis` for shared counters.

2. **Fail-open on rate-limit store errors** — A transient Redis blip should not 500 the API. `passOnStoreError: true` lets traffic through when the store throws.

3. **CSP report-only by default** — A fresh deploy never breaks inline content. After 3-7 days of observing reports, flip `CSP_REPORT_ONLY=false` to enforce.

4. **Idempotency disabled by default** — Stripe-style `Idempotency-Key` header support exists but is off by default. Enable with `IDEMPOTENCY_ENABLED=true` after verifying clients send the header.

## Observability Stack

| System | Purpose | Backend | Frontend |
|--------|---------|---------|----------|
| Sentry | Error tracking | ✅ | ✅ |
| OpenTelemetry | Distributed tracing | ✅ | ❌ |
| Langfuse | LLM observability | ✅ | ❌ |
| PostHog | Analytics / feature flags | ✅ | ✅ |
| Prometheus | Metrics (`/metrics`) | ✅ | ❌ |

## Security Posture

- CSP (Content Security Policy) — report-only mode, enforceable per environment
- CORS — fail-closed in production (rejects all when `CORS_ORIGINS` is empty)
- Helmet security headers — all standard protections enabled
- Rate limiting — anti-bruteforce on auth, quota on expensive endpoints
- Idempotency — replay protection
- Plan quotas — token-based enforcement per user plan
- File upload — MIME validation, path traversal prevention, size limits
- JWT — signed tokens with configurable expiry
- WebAuthn — passkey support (scaffold, needs DB migration to activate)

## Dependencies

- **PostgreSQL 16** — primary data store
- **Redis 7** — BullMQ queues, rate limiting, caching, WebSocket pub/sub
- **Pandoc** — document conversion (server-side, installed in Docker image)
- **Tesseract** — OCR for image-based documents
