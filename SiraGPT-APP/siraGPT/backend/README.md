# SirAGPT Backend

Express API for SirAGPT. It owns authentication, chat persistence, file and
artifact processing, project/document workflows, AI orchestration, multichannel
adapters, observability, and operational guardrails.

The web UI lives at the repository root in Next.js. Backend changes must preserve
the existing public API contracts consumed by that UI unless a coordinated
contract migration is explicitly planned.

## Runtime Stack

- Express.js API server in `backend/index.js`
- Prisma ORM with PostgreSQL via `PRISMA_DATABASE_URL`
- Redis for sessions, queues, rate limits, and cache via `REDIS_URL`
- Multi-provider LLM orchestration in `backend/src/orchestration/`
- Agent queues and workers in `backend/src/services/agents/`
- Structured validation schemas in `backend/src/schemas/`
- Operational checks in `backend/src/utils/config-validator.js` and
  `backend/src/utils/startup-validator.js`

## Local Setup

```bash
cd backend
npm install
cp .env.example .env
npm run db:generate
npm run db:push
npm run dev
```

The API listens on `http://localhost:5000` by default.

## Required Environment

Minimum backend boot variables:

```bash
NODE_ENV=development
PRISMA_DATABASE_URL=postgresql://user:password@localhost:5432/siragpt
JWT_SECRET=<32+ random chars>
SESSION_SECRET=<32+ random chars>
CORS_ORIGINS=http://localhost:3000
```

Recommended local services:

```bash
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=<optional>
ANTHROPIC_API_KEY=<optional>
OPENROUTER_API_KEY=<optional>
```

Full environment documentation lives in `../docs/ENV_VARIABLES.md`.

## Common Commands

```bash
npm run dev                 # nodemon backend/index.js
npm start                   # production-style node backend/index.js
npm test                    # backend node:test suite
npm run test:shard -- 1 4   # run shard 1 of 4
npm run test:coverage       # c8 coverage
npm run db:generate         # generate Prisma client
npm run db:push             # push schema to configured database
npm run generate:openapi    # regenerate OpenAPI spec
```

## Boot Safety

Backend boot runs two validators before serving traffic:

- `config-validator` checks required variables by environment and common
  cross-field mistakes such as production databases pointing at localhost.
- `startup-validator` blocks placeholder secrets, missing Prisma database URLs,
  unsafe database schemes, and other high-risk deploy mistakes.

Production deployments should fail fast on blocking configuration errors instead
of starting with degraded or unsafe defaults.

## CI Notes

The GitHub Actions backend job runs the suite in four shards against real
PostgreSQL and Redis service containers, then boots the API and verifies
`/health`. UI immutability is enforced outside this backend package through the
repository-level UI lock scripts.
