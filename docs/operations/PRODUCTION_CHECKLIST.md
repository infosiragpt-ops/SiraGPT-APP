# 🚀 siraGPT — Production Deployment Checklist

## Pre-Flight Checks

- [ ] **JWT_SECRET** — generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (64 hex chars)
- [ ] **SESSION_SECRET** — same as above (different value)
- [ ] **CORS_ORIGINS** — set to your frontend domain(s), comma-separated
- [ ] **NODE_ENV=production**
- [ ] **Database** — PostgreSQL 16 reachable and migrated (`npx prisma migrate deploy`)
- [ ] **Redis** — reachable (needed for agent tasks, rate limiting, queues)
- [ ] **STRIPE_SECRET_KEY** — set to `sk_live_...` (not `sk_test_...`)
- [ ] **STRIPE_WEBHOOK_SECRET** — set to the live webhook secret
- [ ] **SMTP** — configured for transactional emails
- [ ] **Google OAuth** — `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` configured
- [ ] **OpenAI/Anthropic/Groq API keys** — at least one configured

## Infrastructure

- [ ] **Reverse proxy** — Nginx/Caddy/Traefik in front of the API
- [ ] **SSL/TLS** — Let's Encrypt (auto via Caddy) or cloud LB
- [ ] **Docker** — multi-stage builds verified (`docker compose build --no-cache`)
- [ ] **Health checks** — load balancer uses `/health/live` (liveness) and `/health/ready` (readiness)
- [ ] **Log rotation** — `docker compose` logs configured with `max-size: 10m`
- [ ] **Resource limits** — memory limits set in Docker Compose or orchestrator
- [ ] **Backups** — automated PostgreSQL backups (pg_dump or managed DB)
- [ ] **Upload volume** — persistent volume for `/app/uploads`

## Security

- [ ] **Firewall** — only ports 80/443 (reverse proxy) and 22 (SSH) exposed
- [ ] **Database** — not publicly accessible (listen on internal network only)
- [ ] **Redis** — bound to `127.0.0.1` or Docker internal network; no public port
- [ ] **API keys** — none exposed in client-side code (NEXT_PUBLIC_* only for safe IDs)
- [ ] **CORS** — restricted to origin allowlist
- [ ] **CSP** — after 3-7 days in report-only mode, review reports and enforce
- [ ] **Rate limiting** — verify tiers: auth (30/window), expensive (60), API (1000)
- [ ] **npm audit** — no critical vulnerabilities (`npm audit --audit-level=critical`)
- [ ] **SBOM** — generated and stored for supply-chain auditing
- [ ] **Dependency licenses** — `THIRD_PARTY_LICENSES.md` reviewed

## Monitoring

- [ ] **Sentry** — `SENTRY_DSN` configured; source maps uploaded on deploy
- [ ] **OpenTelemetry** — `OTEL_ENABLED=true` with OTLP endpoint
- [ ] **PostHog** — `POSTHOG_API_KEY` set for product analytics
- [ ] **Health endpoint** — external uptime monitor hitting `/health` every 30s
- [ ] **Metrics** — `/metrics` scraped by Prometheus or observed manually
- [ ] **Alerts** — on health check failure, high error rate, low disk space
- [ ] **Logs** — shipped to centralized logging (Grafana Loki, Papertrail, etc.)

## CI/CD

- [ ] **Frontend build** — passes lint, TypeScript check, tests, `next build`
- [ ] **Backend boot smoke** — `/health` returns 200 within 30s
- [ ] **Security audit** — critical-only, blocks build on failure
- [ ] **License audit** — `THIRD_PARTY_LICENSES.md` up-to-date
- [ ] **Docker image** — built and pushed on every merge to `main`
- [ ] **Rollback** — previous Docker images tagged and accessible

## DNS / Domains

- [ ] `api.siragpt.com` → backend (via reverse proxy)
- [ ] `app.siragpt.com` → frontend (Next.js)
- [ ] Stripe webhook → `https://api.siragpt.com/api/payments/stripe/webhook`
- [ ] Google OAuth redirect → `https://api.siragpt.com/api/auth/google/callback`

---

## One-Time Setup

```bash
# Generate secrets
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "JWT_SECRET=$JWT_SECRET"
echo "SESSION_SECRET=$SESSION_SECRET"

# Deploy with Docker
cp .env.example .env
# Edit .env with your keys
docker compose up -d

# Verify
curl http://localhost:5000/health
curl http://localhost:3000
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Backend won't start | Missing env vars | Check `docker compose logs backend` for startup validator errors |
| Health check fails | DB/Redis not reachable | Verify service containers are healthy: `docker compose ps` |
| CORS errors | Wrong or missing CORS_ORIGINS | Set `CORS_ORIGINS=https://app.siragpt.com` |
| Auth fails | Placeholder JWT_SECRET | Generate a real secret (see one-time setup above) |
| Uploads broken | Missing uploads volume | `docker compose up -d` recreates volumes |
| Rate limiting too strict | Window too small | Adjust `RATE_LIMIT_*` env vars or check Redis connection |
