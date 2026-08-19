# OpenWebUI Backend Setup

This is a complete backend implementation for the OpenWebUI platform with full functionality including authentication, chat management, payments, and admin features.

## Features

### 🔐 Authentication System
- JWT-based authentication
- Session management
- Password hashing with bcrypt
- Protected routes and middleware

### 💬 Chat System
- Real-time chat management
- Message history
- Multiple AI model support
- Token tracking and usage limits

### 💳 Payment Integration
- Stripe integration for subscriptions
- PayPal support
- MercadoPago for Latin America
- Webhook handling for payment events

### 👥 User Management
- User registration and login
- Plan management (Free, Pro, Enterprise)
- API usage tracking
- Monthly limits enforcement

### 🛡️ Admin Panel
- User management
- Payment tracking
- Analytics dashboard
- System monitoring

### 📊 Analytics
- User statistics
- Revenue tracking
- API usage metrics
- Model performance data

## Setup Instructions

### 1. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values:

```bash
cp .env.local.example .env.local
```

### 2. Database Setup

Set up a PostgreSQL database and update the `PRISMA_DATABASE_URL` in your `.env.local` file.

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed database with demo data
npm run db:setup
```

### 3. Start Development Server

```bash
npm run dev
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

### Chats
- `GET /api/chats` - Get user's chats
- `POST /api/chats` - Create new chat
- `GET /api/chats/[id]` - Get specific chat
- `PUT /api/chats/[id]` - Update chat
- `DELETE /api/chats/[id]` - Delete chat
- `POST /api/chats/[id]/messages` - Add message to chat

### AI Generation
- `POST /api/ai/generate` - Generate AI response

### Payments
- `POST /api/payments/stripe` - Create Stripe payment
- `POST /api/payments/stripe/webhook` - Stripe webhook handler

### Admin (Requires admin privileges)
- `GET /api/admin/users` - Get all users
- `GET /api/admin/analytics` - Get analytics data
- `GET /api/admin/payments` - Get all payments

## Database Schema

The application uses Prisma ORM with PostgreSQL. Key models include:

- **User** - User accounts with plans and usage tracking
- **Chat** - Chat conversations
- **Message** - Individual messages in chats
- **Payment** - Payment transactions
- **ApiUsage** - API usage tracking
- **Session** - User sessions

## Payment Integration

### Stripe Setup
1. Create a Stripe account
2. Get your API keys from the Stripe dashboard
3. Set up webhooks for payment events
4. Add keys to `.env.local`

### PayPal Setup
1. Create a PayPal developer account
2. Create an application
3. Get client ID and secret
4. Add to `.env.local`

## Security Features

- Password hashing with bcrypt
- JWT token authentication
- Session management
- Protected API routes
- Admin-only endpoints
- Input validation with Zod
- SQL injection prevention with Prisma

## Monitoring and Analytics

The backend provides comprehensive analytics including:
- User growth and activity
- Revenue tracking
- API usage by model
- Payment status monitoring
- System performance metrics

## API Documentation (OpenAPI 3.1)

The backend ships an auto-generated OpenAPI 3.1 specification covering
all `/api/*` route families (auth, chats, files, payments, ai, admin,
cowork, scientific-search, research-agent, and more).

### Regenerating the spec

```bash
cd backend
npm run generate:openapi         # writes backend/openapi.json + docs/openapi.json
npm run generate:openapi:check   # CI-friendly stale check (exits 1 if drift)
```

The scanner (`backend/scripts/generate-openapi.js`) is purely
AST-based — it does not need to boot the server, hit the database,
or contact Redis. Adding a new route file under `backend/src/routes/`
and mounting it in `backend/index.js` is enough; the next
`generate:openapi` run will pick it up. Tag grouping follows the
route file basename (e.g. `cowork.js` ⇒ tag `cowork`).

### Browsing the spec — Swagger UI

Interactive Swagger UI is mounted at two paths:

- `GET /api-docs` — original path, kept for backward compatibility
- `GET /api/docs` — alias under the `/api` tree (preferred for new clients)

Both surfaces are env-gated:

- **Default ON** in non-production (`NODE_ENV !== 'production'`).
- **Default OFF** in production. Operators can flip it on per-deploy
  with `API_DOCS_ENABLED=true` (typically paired with a basic-auth
  reverse-proxy block or super-admin subdomain). When disabled, both
  paths respond with HTTP 404 and a JSON hint pointing at the env
  var to enable.
- The raw JSON spec is also exposed at `GET /api-docs/openapi.json`
  and `GET /api/docs/openapi.json` for Postman imports and codegen.

### Contract tests

`backend/tests/api-contract.test.js` (25 assertions) verifies that:

- The generated spec is a valid OpenAPI 3.1 document.
- The headline tag groups (`auth`, `chats`, `files`, `payments`,
  `ai`, `admin`, `cowork`, `scientific-search`, `research-agent`)
  are present.
- More than 95% of documented endpoints resolve back to a real
  route declaration in `backend/src/routes/`.
- ~18 high-traffic endpoints (login, register, upload, ai/generate,
  payments webhook, cowork.*, scientific-search, research-agent) are
  individually present.
- The `/api/docs` env-gate behaves correctly across `NODE_ENV` and
  `API_DOCS_ENABLED` combinations.

Run with: `node --test tests/api-contract.test.js` (also included in
the default `npm test` set).

## Health, metrics & observability

- `GET /api/admin/health` — service health probes (DB, Redis, queue,
  OpenAI), super-admin scope.
- `GET /api/admin/analyzer/health` — document analyzer pipeline
  health (per-block telemetry, circuit-breaker state, deadlines).
- `GET /metrics` — Prometheus exposition (localhost OR super-admin token).
- `GET /internal/metrics` — same payload on a dedicated internal
  path so ops can allow-list it through the ingress separately from
  the public mount.
- See `docs/observability.md` and `docs/slo.md` for the full
  OpenTelemetry / Sentry / Langfuse / PostHog setup, dashboards,
  and the SLO catalogue.

## Demo Credentials

After running `npm run db:setup`, you can use:
- **Email**: admin@example.com
- **Password**: password

## Production Deployment

1. Set up a production PostgreSQL database
2. Update environment variables for production
3. Set up Stripe webhooks for your production domain
4. Deploy to your preferred platform (Vercel, Railway, etc.)

## Troubleshooting

### Database Issues
```bash
# Reset database
npx prisma db push --force-reset

# Regenerate client
npx prisma generate
```

### Authentication Issues
- Check JWT_SECRET is set
- Verify token expiration
- Check middleware configuration

### Payment Issues
- Verify Stripe webhook endpoints
- Check API keys are correct
- Monitor webhook logs in Stripe dashboard
## Load Testing

The `backend/scripts/load-test.js` script drives [autocannon](https://github.com/mcollina/autocannon) against a local instance.

```bash
# Install dev dep (already in package.json devDependencies)
npm i

# Default — 50 connections × 10s against all read targets:
node backend/scripts/load-test.js --url http://localhost:5000

# Single endpoint:
node backend/scripts/load-test.js --target providers
node backend/scripts/load-test.js --target models

# Auth flow (requires valid creds):
node backend/scripts/load-test.js --target login \
  --email demo@example.com --password demo123

# Tune connections / duration:
node backend/scripts/load-test.js --connections 100 --duration 30
```

Output includes a live histogram plus a stable summary (`p50`, `p95`, `p99`, `req/s`, `non2xx`, `timeouts`) per target.

> Run against a **test** instance — these targets hit Prisma + the AI model registry. Do not point at production.

## Test Coverage

The backend test suite is instrumented with [c8](https://github.com/bcoe/c8).
A `test:coverage` script runs the same `node --test` battery as `npm test`
under c8 and writes reports under `backend/coverage/`:

```bash
# From backend/
npm run test:coverage

# Reports written:
#   coverage/lcov.info             (CI artifact)
#   coverage/coverage-summary.json (CI artifact, also consumed by tooling)
#   stdout                          text-summary lines
```

### Soft coverage ratchet

`test:coverage` enforces a **soft** threshold that mirrors CI:

| Metric     | Threshold |
|------------|-----------|
| Lines      | 60%       |
| Functions  | 60%       |
| Branches   | 50%       |
| Statements | 60%       |

These numbers sit slightly below the current measured baseline so the
gate catches regressions without nagging the team on every PR. **Raise
them as the baseline improves** — the goal is the ratchet only ever
moves up. To re-baseline:

1. Run `npm run test:coverage` locally and inspect
   `backend/coverage/coverage-summary.json`.
2. If every metric is comfortably (≥ 5 pp) above its threshold, bump
   the `--lines / --functions / --branches / --statements` flags in
   the `test:coverage` script **and** the matching block in
   `.github/workflows/ci.yml` (`Backend tests (shard 1) with coverage`).
3. Commit the bump on its own — it's a CI-policy change, not a feature.

A breaking threshold in CI surfaces as a failed `Backend tests (shard 1)
with coverage` step; locally it surfaces as a non-zero exit from
`npm run test:coverage`. In both cases the c8 output shows which file
dragged the metric down.
